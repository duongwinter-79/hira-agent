import { Command } from 'commander';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  Bus,
  Executor,
  Journal,
  MemoryStore,
  NewMemoryRecordSchema,
  SessionDriver,
  composeSystemPrompt,
  loadBehaviouralSkills,
  loadPlugins,
  loadVerificationConfig,
  type Handoff,
  type LoadedAgent,
  type LoadedSkill,
  type MemoryRecord,
  type PlannerTask,
  type TaskExecution,
} from '@hira/runtime';

/** Specialist agents wired with real system prompts in this milestone. */
const WIRED_OWNERS = new Set<string>([
  'knowledge',
  'solution-architect',
  'developer',
  'tester',
  'reviewer',
]);

/**
 * Tool override for specialist invocations. M1.3 keeps every specialist
 * read-only until the deterministic Verification Engine lands in M1.5.
 * Developer / Tester's manifest Edit/Write/Bash entries are intentionally
 * masked here; they regain those tools when the engine is in place.
 */
const SPECIALIST_READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'];

const program = new Command();
program.name('hira').description('Hira multi-agent orchestrator').version('0.0.1');

// ---------- agents ----------

const agents = program.command('agents').description('Inspect configured agents');

agents
  .command('list')
  .description('List configured agents')
  .option('--plugins-root <path>', 'where to load agents+skills from (default: Hira install dir; env: HIRA_PLUGINS_ROOT)')
  .action(async (opts: { pluginsRoot?: string }) => {
    const pluginsRoot = resolvePluginsRoot(opts.pluginsRoot);
    const { agents } = await loadPlugins(pluginsRoot);
    if (agents.length === 0) {
      console.log(`(no agents found under ${pluginsRoot}/plugins/agents)`);
      return;
    }
    const namePad = Math.max(...agents.map((a) => a.manifest.name.length));
    for (const a of agents) {
      const escalates = a.manifest.escalates_to.length
        ? a.manifest.escalates_to.join(', ')
        : '—';
      const session = a.manifest.session.mode;
      console.log(
        `${a.manifest.name.padEnd(namePad)}  v${a.manifest.version}  session=${session}  escalates_to: ${escalates}`,
      );
    }
  });

// ---------- run ----------

program
  .command('run')
  .description('Run the Orchestrator on a single user message')
  .argument('<message>', 'the user message to send to the Orchestrator')
  .option('--project <path>', 'project root: where .hira/ lives and agents operate', process.cwd())
  .option('--plugins-root <path>', 'where to load agents+skills from (default: Hira install dir; env: HIRA_PLUGINS_ROOT)')
  .option('--dry-run', 'print the assembled claude invocation without spawning')
  .option('--binary <path>', 'path to the claude CLI binary', 'claude')
  .action(
    async (
      message: string,
      opts: { project: string; pluginsRoot?: string; dryRun?: boolean; binary: string },
    ) => {
      const project = resolve(opts.project);
      const pluginsRoot = resolvePluginsRoot(opts.pluginsRoot);
      const { agents, skills } = await loadPlugins(pluginsRoot);
      const orchestrator = agents.find(
        (a: LoadedAgent) => a.manifest.name === 'orchestrator',
      );
      if (!orchestrator) {
        console.error(`No agent named "orchestrator" found under ${pluginsRoot}/plugins/agents/.`);
        process.exit(1);
      }

      const orchestratorPrompt = await renderSystemPrompt(orchestrator, skills);

      if (opts.dryRun) {
        const driver = new SessionDriver();
        const dry = driver.dryRun({
          binary: opts.binary,
          prompt: message,
          systemPrompt: orchestratorPrompt,
          allowedTools: orchestrator.manifest.tools,
          permissionMode: 'acceptEdits',
          cwd: project,
          sessionId: randomUUID(),
          noSessionPersistence: true,
          outputFormat: 'stream-json',
          settingSources: [],
        });
        console.log(dry.display);
        return;
      }

      const journal = new Journal(project);
      const run = await journal.openRun(message);
      const driver = new SessionDriver();
      const bus = new Bus({
        agents,
        skills,
        journal,
        projectRoot: project,
        driver,
        binary: opts.binary,
      });

      try {
        // Hand-off 1: user → orchestrator (intent classification).
        const orcEnvelope: Handoff = {
          run_id: run.id,
          handoff_id: randomUUID(),
          from: 'user',
          to: 'orchestrator',
          kind: 'request',
          payload: { message },
          artifacts: [],
          delta_refs: [],
        };
        const orcResult = await bus.dispatch(orcEnvelope);

        if (orcResult.exitCode !== 0) {
          await fail(journal, run.id, `orchestrator exited with code ${orcResult.exitCode}`, orcResult.stderrExcerpt);
          return;
        }

        const decision = parseDecision(orcResult);
        if (!decision) {
          process.stdout.write(orcResult.responseText.trimEnd() + '\n');
          process.stderr.write(`(warning: orchestrator output had no parseable fenced JSON)\n`);
          await journal.closeRun(run.id, 'succeeded');
          console.error(`(run_id: ${run.id})`);
          return;
        }

        if (decision.action === 'reply') {
          process.stdout.write(decision.message.trimEnd() + '\n');
          await journal.closeRun(run.id, 'succeeded');
          console.error(`(run_id: ${run.id})`);
          return;
        }

        // Hand-off 2: orchestrator → planner.
        const planEnvelope: Handoff = {
          run_id: run.id,
          handoff_id: randomUUID(),
          parent_handoff_id: orcEnvelope.handoff_id,
          from: 'orchestrator',
          to: decision.target,
          kind: 'request',
          payload: decision.payload,
          artifacts: [],
          delta_refs: [],
        };
        const planResult = await bus.dispatch(planEnvelope);

        if (planResult.exitCode !== 0) {
          await fail(
            journal,
            run.id,
            `${decision.target} exited with code ${planResult.exitCode}`,
            planResult.stderrExcerpt,
          );
          return;
        }

        const tasks = parseTasks(planResult.response);
        if (tasks === null) {
          // Planner didn't follow the contract; surface its raw output.
          process.stdout.write(`Dispatched to ${decision.target}. Plan:\n`);
          process.stdout.write(planResult.responseText.trimEnd() + '\n');
          process.stderr.write(
            `(warning: ${decision.target} produced no parseable task graph; executor skipped)\n`,
          );
          await journal.closeRun(run.id, 'succeeded');
          console.error(`(run_id: ${run.id})`);
          return;
        }

        // Query memory for context relevant to this Run, inject into each
        // task's payload as `memory_context`. Specialists (especially
        // Knowledge) cite by `memory:<id>` when they build on prior facts.
        const memory = new MemoryStore(project);
        const memoryContext = await memory.query(message, 5);
        const tasksWithMemory: PlannerTask[] = tasks.map((t) => ({ ...t }));

        // Load the deterministic Verification Engine config (SPEC §4.8).
        // Absent hira.config.json → engine reports `skipped`.
        const verificationConfig = await loadVerificationConfig(project);

        // Walk the task graph through wired specialists.
        const executor = new Executor({
          bus,
          journal,
          projectRoot: project,
          wiredOwners: WIRED_OWNERS,
          toolsOverride: SPECIALIST_READ_ONLY_TOOLS,
          memoryContext,
          verificationConfig,
        });
        const execOut = await executor.run({
          runId: run.id,
          parentHandoffId: planEnvelope.handoff_id,
          tasks: tasksWithMemory,
        });

        if (execOut.graph_error) {
          await fail(journal, run.id, `Planner produced an invalid task graph: ${execOut.graph_error}`);
          return;
        }

        // Memory Maintainer: read the chain and extract new records.
        // Runs before synthesis so the synthesis can announce records written.
        const newRecords = await runMemoryMaintainer({
          bus,
          journal,
          memory,
          runId: run.id,
          parentHandoffId: planEnvelope.handoff_id,
          intent: message,
          plan: planResult.response,
          executions: execOut.executions,
        });

        // Synthesis: hand back to the orchestrator with the full chain so
        // it can compose a user-facing reply.
        const synthEnvelope: Handoff = {
          run_id: run.id,
          handoff_id: randomUUID(),
          parent_handoff_id: planEnvelope.handoff_id,
          from: 'user',
          to: 'orchestrator',
          kind: 'response',
          payload: {
            message: buildSynthesisPrompt(
              message,
              planResult.response,
              execOut.executions,
              memoryContext,
              newRecords,
            ),
          },
          artifacts: [],
          delta_refs: [],
        };
        const synthResult = await bus.dispatch(synthEnvelope);

        if (synthResult.exitCode !== 0) {
          await fail(
            journal,
            run.id,
            `orchestrator (synthesis) exited with code ${synthResult.exitCode}`,
            synthResult.stderrExcerpt,
          );
          return;
        }

        const synthDecision = parseDecision(synthResult);
        const summary =
          synthDecision?.action === 'reply'
            ? synthDecision.message
            : synthResult.responseText;
        process.stdout.write(summary.trimEnd() + '\n');
        if (synthDecision?.action !== 'reply') {
          process.stderr.write(
            `(warning: orchestrator synthesis returned no parseable {action:'reply'} block)\n`,
          );
        }
        await journal.closeRun(run.id, 'succeeded');
        console.error(`(run_id: ${run.id})`);
      } catch (err) {
        await journal.closeRun(run.id, 'failed').catch(() => undefined);
        throw err;
      }
    },
  );

// ---------- runs ----------

const runs = program.command('runs').description('Inspect Run history');

runs
  .command('list')
  .description('List recent Runs in the current project')
  .option('--project <path>', 'project root', process.cwd())
  .option('--limit <n>', 'maximum runs to show', (v) => Number.parseInt(v, 10), 20)
  .action(async (opts: { project: string; limit: number }) => {
    const journal = new Journal(resolve(opts.project));
    const list = await journal.listRuns(opts.limit);
    if (list.length === 0) {
      console.log('(no runs yet)');
      return;
    }
    for (const r of list) {
      const intent =
        r.intent_message.length > 60
          ? r.intent_message.slice(0, 57) + '...'
          : r.intent_message;
      console.log(
        `${r.id}  ${r.started_at}  ${r.status.padEnd(10)}  ${intent}`,
      );
    }
  });

runs
  .command('show')
  .description('Show a Run: hand-off tree and artifacts')
  .argument('<run_id>')
  .option('--project <path>', 'project root', process.cwd())
  .action(async (runId: string, opts: { project: string }) => {
    const journal = new Journal(resolve(opts.project));
    const data = await journal.getRun(runId);
    if (!data) {
      console.error(`run not found: ${runId}`);
      process.exit(1);
    }
    const { run, handoffs, artifacts } = data;
    console.log(`Run ${run.id}`);
    console.log(`  status:  ${run.status}`);
    console.log(`  started: ${run.started_at}`);
    if (run.ended_at) console.log(`  ended:   ${run.ended_at}`);
    console.log(`  intent:  ${run.intent_message}`);
    console.log();
    console.log(`Hand-offs (${handoffs.length}):`);
    for (const h of handoffs) {
      const arrow = `${h.from} → ${h.to}`;
      const dur =
        h.ended_at && h.started_at
          ? ` (${Math.round((Date.parse(h.ended_at) - Date.parse(h.started_at)) / 100) / 10}s)`
          : '';
      const parent = h.parent_handoff_id ? `  parent=${h.parent_handoff_id}` : '';
      console.log(
        `  - ${h.handoff_id}  ${h.kind.padEnd(10)} ${arrow}  ${h.status}${dur}${parent}`,
      );
      if (h.exit_code !== undefined && h.exit_code !== 0) {
        console.log(`      exit_code: ${h.exit_code}`);
      }
      if (h.session_id) console.log(`      session_id: ${h.session_id}`);
      if (h.response_text) {
        const oneLine = h.response_text.replace(/\s+/g, ' ').trim();
        console.log(
          `      reply: ${oneLine.length > 100 ? oneLine.slice(0, 97) + '...' : oneLine}`,
        );
      }
    }
    if (artifacts.length > 0) {
      console.log();
      console.log(`Artifacts (${artifacts.length}):`);
      for (const a of artifacts) {
        console.log(`  - ${a.id}  (handoff ${a.handoff_id ?? '—'})`);
      }
    }
  });

// ---------- memory ----------

const memoryCmd = program.command('memory').description('Inspect the project memory store');

memoryCmd
  .command('list')
  .description('List memory records, newest first')
  .option('--project <path>', 'project root', process.cwd())
  .option('--kind <kind>', 'filter by kind (adr|outcome|convention|glossary)')
  .option('--limit <n>', 'maximum records to show', (v) => Number.parseInt(v, 10), 20)
  .action(async (opts: { project: string; kind?: string; limit: number }) => {
    const store = new MemoryStore(resolve(opts.project));
    const filters: { kind?: 'adr' | 'outcome' | 'convention' | 'glossary' } = {};
    if (opts.kind) {
      if (!['adr', 'outcome', 'convention', 'glossary'].includes(opts.kind)) {
        console.error(`Unknown kind '${opts.kind}'. Use adr|outcome|convention|glossary.`);
        process.exit(1);
      }
      filters.kind = opts.kind as typeof filters.kind;
    }
    const records = (await store.list(filters)).slice(0, opts.limit);
    if (records.length === 0) {
      console.log('(no memory records)');
      return;
    }
    const idPad = Math.max(...records.map((r) => r.id.length));
    for (const r of records) {
      const tags = r.tags.length ? `[${r.tags.join(',')}]` : '';
      const title = r.title.length > 70 ? r.title.slice(0, 67) + '...' : r.title;
      console.log(`${r.id.padEnd(idPad)}  ${r.created_at}  ${title}  ${tags}`);
    }
  });

memoryCmd
  .command('show')
  .description('Show one memory record')
  .argument('<id>')
  .option('--project <path>', 'project root', process.cwd())
  .action(async (id: string, opts: { project: string }) => {
    const store = new MemoryStore(resolve(opts.project));
    const r = await store.get(id);
    if (!r) {
      console.error(`memory record not found: ${id}`);
      process.exit(1);
    }
    console.log(`${r.id} (${r.kind})`);
    console.log(`  title:   ${r.title}`);
    console.log(`  tags:    ${r.tags.join(', ') || '—'}`);
    console.log(`  created: ${r.created_at}`);
    if (r.source?.run_id) console.log(`  source:  run ${r.source.run_id}`);
    console.log();
    console.log(r.body);
  });

memoryCmd
  .command('query')
  .description('Keyword query against the memory store')
  .argument('<text>')
  .option('--project <path>', 'project root', process.cwd())
  .option('--limit <n>', 'maximum hits', (v) => Number.parseInt(v, 10), 5)
  .action(async (text: string, opts: { project: string; limit: number }) => {
    const store = new MemoryStore(resolve(opts.project));
    const hits = await store.query(text, opts.limit);
    if (hits.length === 0) {
      console.log('(no matches)');
      return;
    }
    for (const r of hits) {
      const tags = r.tags.length ? `[${r.tags.join(',')}]` : '';
      console.log(`${r.id}  ${r.title}  ${tags}`);
    }
  });

await program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

// ---------- helpers ----------

/**
 * Resolve the directory that contains Hira's `plugins/` tree.
 *
 * Resolution order:
 *   1. Explicit --plugins-root flag.
 *   2. HIRA_PLUGINS_ROOT environment variable.
 *   3. Walk up from the running binary's location looking for a
 *      sibling `plugins/agents/` directory. This works when the
 *      CLI is invoked via the workspace (`node packages/cli/dist/...`)
 *      or via `pnpm link --global` (which symlinks but
 *      `import.meta.url` still resolves to the real file).
 *
 * If none match, prints a helpful error and exits.
 */
function resolvePluginsRoot(explicit?: string): string {
  if (explicit) return resolve(explicit);
  if (process.env.HIRA_PLUGINS_ROOT) return resolve(process.env.HIRA_PLUGINS_ROOT);

  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (hasPluginsDir(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  console.error(
    'Could not find Hira plugins/. Pass --plugins-root or set HIRA_PLUGINS_ROOT.',
  );
  process.exit(1);
}

function hasPluginsDir(dir: string): boolean {
  try {
    return statSync(join(dir, 'plugins', 'agents')).isDirectory();
  } catch {
    return false;
  }
}

async function renderSystemPrompt(
  agent: LoadedAgent,
  skills: LoadedSkill[],
): Promise<string> {
  const behavioural = await loadBehaviouralSkills(skills, agent.manifest.skills);
  return composeSystemPrompt(agent.systemPrompt, behavioural);
}

type OrchestratorDecision =
  | { action: 'reply'; message: string }
  | { action: 'dispatch'; target: string; payload: unknown };

function parseDecision(result: {
  response: unknown | null;
}): OrchestratorDecision | null {
  const r = result.response;
  if (!r || typeof r !== 'object') return null;
  const action = (r as { action?: unknown }).action;
  if (action === 'reply') {
    const message = (r as { message?: unknown }).message;
    if (typeof message !== 'string') return null;
    return { action: 'reply', message };
  }
  if (action === 'dispatch') {
    const target = (r as { target?: unknown }).target;
    if (typeof target !== 'string') return null;
    const payload = (r as { payload?: unknown }).payload;
    return { action: 'dispatch', target, payload };
  }
  return null;
}

function parseTasks(response: unknown): PlannerTask[] | null {
  if (!response || typeof response !== 'object') return null;
  const raw = (response as { tasks?: unknown }).tasks;
  if (!Array.isArray(raw)) return null;
  const tasks: PlannerTask[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') return null;
    const t = r as Partial<PlannerTask>;
    if (
      typeof t.id !== 'string' ||
      typeof t.description !== 'string' ||
      typeof t.owner !== 'string' ||
      !Array.isArray(t.depends_on) ||
      !t.depends_on.every((d) => typeof d === 'string')
    ) {
      return null;
    }
    tasks.push({ id: t.id, description: t.description, owner: t.owner, depends_on: t.depends_on });
  }
  return tasks;
}

function buildSynthesisPrompt(
  intent: string,
  plan: unknown,
  executions: TaskExecution[],
  memoryContext: MemoryRecord[],
  memoryRecordsWritten: MemoryRecord[],
): string {
  const taskResults = executions.map((e) => ({
    task_id: e.task.id,
    owner: e.task.owner,
    status: e.status,
    skip_reason: e.skip_reason,
    response: e.response,
    verification: e.verification,
  }));
  return [
    'SYNTHESIS REQUEST',
    '',
    `original_intent: ${intent}`,
    '',
    'memory_context (records the runtime fetched for this Run):',
    JSON.stringify(
      memoryContext.map((r) => ({ id: r.id, title: r.title, tags: r.tags })),
      null,
      2,
    ),
    '',
    'plan:',
    JSON.stringify(plan, null, 2),
    '',
    'task_results (in dependency order):',
    JSON.stringify(taskResults, null, 2),
    '',
    'memory_records_written (newly persisted by the Memory Maintainer):',
    JSON.stringify(
      memoryRecordsWritten.map((r) => ({ id: r.id, kind: r.kind, title: r.title })),
      null,
      2,
    ),
    '',
    'Compose the user-facing reply per your synthesis rules.',
  ].join('\n');
}

async function runMemoryMaintainer(args: {
  bus: Bus;
  journal: Journal;
  memory: MemoryStore;
  runId: string;
  parentHandoffId: string;
  intent: string;
  plan: unknown;
  executions: TaskExecution[];
}): Promise<MemoryRecord[]> {
  const envelope: Handoff = {
    run_id: args.runId,
    handoff_id: randomUUID(),
    parent_handoff_id: args.parentHandoffId,
    from: 'orchestrator',
    to: 'memory',
    kind: 'request',
    payload: {
      original_intent: args.intent,
      plan: args.plan,
      task_results: args.executions.map((e) => ({
        task_id: e.task.id,
        owner: e.task.owner,
        status: e.status,
        skip_reason: e.skip_reason,
        response: e.response,
      })),
    },
    artifacts: [],
    delta_refs: [],
  };

  const result = await args.bus.dispatch(envelope);
  if (result.exitCode !== 0) {
    process.stderr.write(
      `(warning: memory maintainer exited ${result.exitCode}; no records persisted for this Run)\n`,
    );
    return [];
  }

  const proposed = parseMemoryRecords(result.response);
  if (proposed.length === 0) return [];

  const persisted: MemoryRecord[] = [];
  for (const r of proposed) {
    try {
      const validated = NewMemoryRecordSchema.parse({
        ...r,
        source: { run_id: args.runId, handoff_id: envelope.handoff_id },
      });
      const written = await args.memory.write(validated);
      persisted.push(written);
    } catch (err) {
      process.stderr.write(
        `(warning: skipping malformed memory record: ${err instanceof Error ? err.message : String(err)})\n`,
      );
    }
  }
  return persisted;
}

function parseMemoryRecords(response: unknown): unknown[] {
  if (!response || typeof response !== 'object') return [];
  const raw = (response as { records?: unknown }).records;
  return Array.isArray(raw) ? raw : [];
}

async function fail(
  journal: Journal,
  runId: string,
  message: string,
  stderrExcerpt?: string,
): Promise<never> {
  console.error(message);
  if (stderrExcerpt) console.error(stderrExcerpt.trimEnd());
  console.error(`(run_id: ${runId})`);
  await journal.closeRun(runId, 'failed');
  process.exit(1);
}
