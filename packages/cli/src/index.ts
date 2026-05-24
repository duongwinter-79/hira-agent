import { Command } from 'commander';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  BudgetExhausted,
  BudgetTracker,
  Bus,
  Executor,
  Journal,
  MemoryStore,
  NewMemoryRecordSchema,
  SessionDriver,
  buildRunTrace,
  composeSystemPrompt,
  createRunWorktree,
  deleteRunBranch,
  finalizeWorktree,
  isGitRepo,
  loadBehaviouralSkills,
  loadBudgetConfig,
  loadPlugins,
  loadVerificationConfig,
  loadWorktreeSetupCommand,
  readMemoryDelta,
  runWorktreeSetup,
  traceArtifact,
  writeMemoryDelta,
  type ConsistencyReport,
  type Handoff,
  type LoadedAgent,
  type LoadedSkill,
  type MemoryRecord,
  type NewMemoryRecord,
  type PlannerTask,
  type RunRecord,
  type RunWorktree,
  type TaskExecution,
  type WorktreeOutcome,
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
 * Owners whose results may be reused on resume (SPEC M1.4). Their output is
 * self-contained — no filesystem side effects. Developer / Tester / Reviewer
 * touch the worktree, whose state is lost on a crash, so they always re-run.
 */
const RESUMABLE_OWNERS = new Set<string>(['knowledge', 'solution-architect']);

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
      const mcpSkillsServer = resolveMcpSkillsServer(pluginsRoot);
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

      // Per-Run budget tracker (SPEC §9). Null config → no caps enforced.
      const budgetCfg = await loadBudgetConfig(project);
      const budget = budgetCfg ? new BudgetTracker(budgetCfg) : undefined;

      const bus = new Bus({
        agents,
        skills,
        journal,
        projectRoot: project,
        driver,
        binary: opts.binary,
        ...(mcpSkillsServer ? { mcpSkillsServerPath: mcpSkillsServer } : {}),
        ...(budget ? { budget } : {}),
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

        // Run the post-plan pipeline (memory → executor → maintainer →
        // synthesis). Shared with `hira runs resume`.
        await runPipeline({
          project,
          binary: opts.binary,
          agents,
          skills,
          journal,
          bus,
          runId: run.id,
          intent: message,
          planHandoffId: planEnvelope.handoff_id,
          planResponse: planResult.response,
          tasks,
        });
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
        r.intent_message.length > 54
          ? r.intent_message.slice(0, 51) + '...'
          : r.intent_message;
      const approval = (r.approval ?? 'pending').padEnd(8);
      console.log(
        `${r.id}  ${r.started_at}  ${r.status.padEnd(10)}  ${approval}  ${intent}`,
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
    console.log(`  status:   ${run.status}`);
    console.log(`  approval: ${run.approval ?? 'pending'}`);
    console.log(`  started:  ${run.started_at}`);
    if (run.ended_at) console.log(`  ended:    ${run.ended_at}`);
    console.log(`  intent:   ${run.intent_message}`);
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
      if (h.schema_error) console.log(`      schema_error: ${h.schema_error}`);
      if (h.response_text) {
        const oneLine = h.response_text.replace(/\s+/g, ' ').trim();
        console.log(
          `      reply: ${oneLine.length > 100 ? oneLine.slice(0, 97) + '...' : oneLine}`,
        );
      }
      if (h.progress && h.progress.length > 0) {
        const last = h.progress[h.progress.length - 1]!;
        console.log(
          `      progress: ${h.progress.length} event(s), last: ${last.phase}${last.detail ? ` ${last.detail}` : ''}`,
        );
        // For a hand-off that never completed (a crash), show the trail so
        // the user can see exactly how far the agent got.
        if (h.status === 'in_progress') {
          for (const p of h.progress.slice(-8)) {
            console.log(`        · ${p.phase}${p.detail ? ` — ${p.detail}` : ''}`);
          }
        }
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

runs
  .command('trace')
  .description('Trace a Run or artifact: requirement ↔ task ↔ artifact, both directions')
  .argument('<id>', 'a run id (or prefix), or an artifact id (kind:run:seq)')
  .option('--project <path>', 'project root', process.cwd())
  .action(async (id: string, opts: { project: string }) => {
    const journal = new Journal(resolve(opts.project));
    const runs = await journal.listRuns(500);

    // An artifact id is `<kind>:<run_short>:<seq>` — three colon-separated parts.
    const parts = id.split(':');
    const isArtifactId = parts.length === 3;

    const runShort = isArtifactId ? parts[1]! : id;
    const run =
      runs.find((r) => r.id === runShort) ?? runs.find((r) => r.id.startsWith(runShort));
    if (!run) {
      console.error(
        isArtifactId
          ? `no Run found for artifact '${id}' (prefix '${runShort}')`
          : `run not found: ${id}`,
      );
      process.exit(1);
    }

    const data = await journal.getRun(run.id);
    if (!data) {
      console.error(`run not found: ${run.id}`);
      process.exit(1);
    }
    const trace = buildRunTrace(data.run, data.handoffs, data.artifacts);

    if (isArtifactId) {
      const at = traceArtifact(trace, id);
      if (!at) {
        console.error(`artifact not found in Run ${run.id}: ${id}`);
        process.exit(1);
      }
      console.log(`Trace — artifact ${at.artifact.id}`);
      console.log(`  kind: ${at.artifact.kind}   run: ${run.id}`);
      if (at.task) {
        console.log(`  produced by: task ${at.task.id} (${at.task.owner})`);
      }
      console.log();
      console.log('Backward — requirements that led here:');
      console.log(`  intent: ${trace.run.intent_message}`);
      for (const t of at.ancestors) {
        console.log(`   → ${t.id} ${t.owner}  [${t.status}]`);
      }
      if (at.task) console.log(`   → ${at.task.id} ${at.task.owner}  ← produced ${at.artifact.id}`);
      console.log();
      console.log('Forward — work that consumed it:');
      if (at.descendants.length === 0) {
        console.log('  (nothing depended on this task)');
      } else {
        for (const t of at.descendants) {
          console.log(`   → ${t.id} ${t.owner}  [${t.status}]`);
        }
      }
      console.log();
      console.log('Payload:');
      console.log(`  ${summariseArtifactPayload(at.artifact.payload)}`);
      return;
    }

    // Run trace.
    console.log(`Trace — Run ${trace.run.id}`);
    console.log(`  intent: ${trace.run.intent_message}`);
    console.log(`  status: ${trace.run.status}`);
    console.log();
    if (trace.framing.length > 0) {
      const framing = trace.framing
        .map((f) => `${f.from}→${f.to}(${f.status})`)
        .join('  ');
      console.log(`Framing: ${framing}`);
      console.log();
    }
    if (trace.tasks.length === 0) {
      console.log('(no task graph — this Run was answered directly by the Orchestrator)');
      return;
    }
    console.log('Task chain (Planner graph, dependency order):');
    for (const t of trace.tasks) {
      const deps = t.depends_on.length ? t.depends_on.join(',') : '—';
      const attempts = t.attempts ? `  attempts:${t.attempts}` : '';
      console.log(
        `  ${t.id}  ${t.owner.padEnd(18)} deps:${deps.padEnd(10)} [${t.status}]${attempts}`,
      );
      for (const a of t.artifacts) {
        console.log(`       ◆ ${a.id}  ${summariseArtifactPayload(a.payload)}`);
      }
    }
  });

runs
  .command('approve')
  .description('Approve a Run: fold its memory deltas into the baseline (SPEC §4.8)')
  .argument('<run_id>', 'a run id or unique prefix')
  .option('--project <path>', 'project root', process.cwd())
  .action(async (runId: string, opts: { project: string }) => {
    const project = resolve(opts.project);
    const journal = new Journal(project);
    const run = await resolveRun(journal, runId);
    if (!run) {
      console.error(`run not found: ${runId}`);
      process.exit(1);
    }
    if (run.status !== 'succeeded') {
      console.error(`cannot approve Run ${run.id}: status is '${run.status}' (only succeeded Runs).`);
      process.exit(1);
    }
    if (run.approval) {
      console.error(`Run ${run.id} already has a decision: ${run.approval}.`);
      process.exit(1);
    }

    const deltas = await readMemoryDelta(journal.runDir(run.id));
    const memory = new MemoryStore(project);
    let folded = 0;
    for (const record of deltas) {
      await memory.write(record);
      folded++;
    }
    await journal.recordApproval(run.id, 'approved');

    console.log(`Approved Run ${run.id}.`);
    console.log(`  ${folded} memory record(s) folded into the baseline store.`);
    const branch = `hira/run-${run.id.slice(0, 8)}`;
    console.log(`  Code changes (if any) are on branch ${branch} — merge with: git merge ${branch}`);
  });

runs
  .command('reject')
  .description("Reject a Run: discard its deltas and delete its worktree branch")
  .argument('<run_id>', 'a run id or unique prefix')
  .option('--project <path>', 'project root', process.cwd())
  .action(async (runId: string, opts: { project: string }) => {
    const project = resolve(opts.project);
    const journal = new Journal(project);
    const run = await resolveRun(journal, runId);
    if (!run) {
      console.error(`run not found: ${runId}`);
      process.exit(1);
    }
    if (run.approval) {
      console.error(`Run ${run.id} already has a decision: ${run.approval}.`);
      process.exit(1);
    }

    await journal.recordApproval(run.id, 'rejected');
    const branch = `hira/run-${run.id.slice(0, 8)}`;
    const deleted = await deleteRunBranch(project, branch);

    console.log(`Rejected Run ${run.id}.`);
    console.log('  Memory deltas were not folded; the baseline is unchanged.');
    console.log(
      deleted
        ? `  Deleted worktree branch ${branch}.`
        : `  No worktree branch ${branch} to delete.`,
    );
  });

runs
  .command('resume')
  .description('Resume an interrupted Run, reusing completed research/design (SPEC M1.4)')
  .argument('<run_id>', 'a run id or unique prefix')
  .option('--project <path>', 'project root', process.cwd())
  .option(
    '--plugins-root <path>',
    'where to load agents+skills from (default: Hira install dir; env: HIRA_PLUGINS_ROOT)',
  )
  .option('--binary <path>', 'path to the claude CLI binary', 'claude')
  .action(
    async (runId: string, opts: { project: string; pluginsRoot?: string; binary: string }) => {
      const project = resolve(opts.project);
      const journal = new Journal(project);

      const run = await resolveRun(journal, runId);
      if (!run) {
        console.error(`run not found: ${runId}`);
        process.exit(1);
      }
      if (run.status === 'succeeded') {
        console.error(`Run ${run.id} already succeeded; nothing to resume.`);
        process.exit(1);
      }
      if (run.approval) {
        console.error(`Run ${run.id} already has a decision (${run.approval}); cannot resume.`);
        process.exit(1);
      }

      const data = await journal.getRun(run.id);
      if (!data) {
        console.error(`run not found: ${run.id}`);
        process.exit(1);
      }

      // Reconstruct the plan from the original Planner hand-off.
      const planHandoff = data.handoffs.find(
        (h) => h.to === 'planner' && h.status === 'completed',
      );
      if (!planHandoff) {
        console.error(
          `Run ${run.id} has no completed plan to resume from. Run it again from scratch.`,
        );
        process.exit(1);
      }
      const tasks = parseTasks(planHandoff.response);
      if (tasks === null) {
        console.error(`Run ${run.id}'s recorded plan is unparseable. Run it again from scratch.`);
        process.exit(1);
      }

      // Reuse completed self-contained task results (Knowledge, Architect).
      // Worktree-touching owners always re-run — their filesystem state is gone.
      const priorResults = new Map<string, { response: unknown; responseText: string }>();
      for (const h of data.handoffs) {
        if (h.task_id && h.status === 'completed' && RESUMABLE_OWNERS.has(h.to)) {
          priorResults.set(h.task_id, {
            response: h.response,
            responseText: h.response_text ?? '',
          });
        }
      }

      const pluginsRoot = resolvePluginsRoot(opts.pluginsRoot);
      const { agents, skills } = await loadPlugins(pluginsRoot);
      const driver = new SessionDriver();

      const budgetCfg = await loadBudgetConfig(project);
      const budget = budgetCfg ? new BudgetTracker(budgetCfg) : undefined;

      const bus = new Bus({
        agents,
        skills,
        journal,
        projectRoot: project,
        driver,
        binary: opts.binary,
        ...(resolveMcpSkillsServer(pluginsRoot)
          ? { mcpSkillsServerPath: resolveMcpSkillsServer(pluginsRoot) }
          : {}),
        ...(budget ? { budget } : {}),
      });

      process.stderr.write(
        `(resume: ${run.id} — ${tasks.length} task(s), ${priorResults.size} reusable)\n`,
      );
      await runPipeline({
        project,
        binary: opts.binary,
        agents,
        skills,
        journal,
        bus,
        runId: run.id,
        intent: run.intent_message,
        planHandoffId: planHandoff.handoff_id,
        planResponse: planHandoff.response,
        tasks,
        priorResults,
      });
    },
  );

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

/**
 * Locate the built `@hira/mcp-skills` server inside the Hira install.
 * Returns undefined when it's not built — MCP skills then degrade to
 * silently inert (the runtime consistency gate still runs regardless).
 */
function resolveMcpSkillsServer(pluginsRoot: string): string | undefined {
  const serverPath = join(pluginsRoot, 'packages', 'mcp-skills', 'dist', 'server.js');
  try {
    statSync(serverPath);
    return serverPath;
  } catch {
    return undefined;
  }
}

async function renderSystemPrompt(
  agent: LoadedAgent,
  skills: LoadedSkill[],
): Promise<string> {
  const behavioural = await loadBehaviouralSkills(skills, agent.manifest.skills);
  return composeSystemPrompt(agent.systemPrompt, behavioural);
}

/** Resolve a run by full id or unique prefix. */
async function resolveRun(journal: Journal, idOrPrefix: string): Promise<RunRecord | undefined> {
  const list = await journal.listRuns(500);
  return list.find((r) => r.id === idOrPrefix) ?? list.find((r) => r.id.startsWith(idOrPrefix));
}

/** One-line summary of an artifact's payload for the trace view. */
function summariseArtifactPayload(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return String(payload ?? '');
  const status = (payload as { status?: unknown }).status;
  const stages = (payload as { stages?: unknown }).stages;
  if (typeof status === 'string' && Array.isArray(stages)) {
    const parts = stages
      .map((s) => {
        const st = s as { name?: unknown; status?: unknown };
        return typeof st.name === 'string' ? `${st.name}:${String(st.status)}` : null;
      })
      .filter((s): s is string => s !== null);
    return `${status}  (${parts.join(', ')})`;
  }
  if (typeof status === 'string') return status;
  const json = JSON.stringify(payload);
  return json.length > 80 ? json.slice(0, 77) + '...' : json;
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

type PipelineArgs = {
  project: string;
  binary: string;
  agents: LoadedAgent[];
  skills: LoadedSkill[];
  journal: Journal;
  bus: Bus;
  runId: string;
  intent: string;
  /** Hand-off id of the Planner invocation — parent of the executor tasks. */
  planHandoffId: string;
  /** The Planner's raw response, passed to the Memory Maintainer + synthesis. */
  planResponse: unknown;
  tasks: PlannerTask[];
  /** Task results carried over from a prior Run (resume — SPEC M1.4). */
  priorResults?: Map<string, { response: unknown; responseText: string }>;
};

/**
 * The post-plan Run pipeline: memory query → worktree → executor →
 * verification → memory delta → synthesis. Shared by `hira run` and
 * `hira runs resume`. Owns the worktree lifecycle and closes the Run.
 */
async function runPipeline(args: PipelineArgs): Promise<void> {
  const { project, journal, bus, runId, intent, planHandoffId, planResponse, tasks } = args;
  let worktree: RunWorktree | undefined;

  try {
    const memory = new MemoryStore(project);
    const memoryContext = await memory.query(intent, 5);
    const verificationConfig = await loadVerificationConfig(project);

    // If the plan implements code, create an isolated git worktree so the
    // Developer edits for real without touching the main checkout (§4.8).
    if (tasks.some((t) => t.owner === 'developer') && (await isGitRepo(project))) {
      worktree = await createRunWorktree(project, runId);
      process.stderr.write(`(worktree: ${worktree.branch})\n`);
      const setupCmd = await loadWorktreeSetupCommand(project);
      if (setupCmd) {
        const setup = await runWorktreeSetup(worktree.path, setupCmd);
        if (!setup.ok) {
          process.stderr.write(
            `(warning: worktree setup '${setupCmd}' failed; verification may not run)\n`,
          );
        }
      }
    }

    const baselineAdrs = (await memory.list({ kind: 'adr' })).map((r) => ({
      id: r.id,
      title: r.title,
      tags: r.tags,
    }));

    const executor = new Executor({
      bus,
      journal,
      projectRoot: project,
      wiredOwners: WIRED_OWNERS,
      toolsOverride: SPECIALIST_READ_ONLY_TOOLS,
      memoryContext,
      verificationConfig,
      knownOwners: new Set(args.agents.map((a) => a.manifest.name)),
      baselineAdrs,
      ...(args.priorResults ? { priorResults: args.priorResults } : {}),
      ...(worktree ? { worktree: { path: worktree.path } } : {}),
    });
    const execOut = await executor.run({ runId, parentHandoffId: planHandoffId, tasks });

    if (execOut.graph_error) {
      if (worktree) await finalizeWorktree(project, worktree).catch(() => undefined);
      await fail(journal, runId, `Planner produced an invalid task graph: ${execOut.graph_error}`);
      return;
    }

    const reused = execOut.executions.filter((e) => e.resumed).length;
    if (reused > 0) {
      process.stderr.write(`(resume: reused ${reused} prior task result(s))\n`);
    }

    // Commit the Developer's worktree changes to its branch; remove the dir.
    let worktreeOutcome: WorktreeOutcome | undefined;
    if (worktree) {
      worktreeOutcome = await finalizeWorktree(project, worktree);
      process.stderr.write(
        worktreeOutcome.committed
          ? `(worktree: ${worktreeOutcome.changedFiles} file(s) committed to ${worktreeOutcome.branch})\n`
          : `(worktree: no file changes on ${worktreeOutcome.branch})\n`,
      );
    }

    // Memory Maintainer stages proposed records as this Run's delta.
    const newRecords = await runMemoryMaintainer({
      bus,
      journal,
      runDir: journal.runDir(runId),
      runId,
      parentHandoffId: planHandoffId,
      intent,
      plan: planResponse,
      executions: execOut.executions,
    });

    // Synthesis: the orchestrator composes the user-facing reply.
    const synthEnvelope: Handoff = {
      run_id: runId,
      handoff_id: randomUUID(),
      parent_handoff_id: planHandoffId,
      from: 'user',
      to: 'orchestrator',
      kind: 'response',
      payload: {
        message: buildSynthesisPrompt(
          intent,
          runId,
          planResponse,
          execOut.executions,
          memoryContext,
          newRecords,
          {
            gateFailed: execOut.gate_failed ?? false,
            worktree: worktreeOutcome,
            consistency: execOut.consistency,
          },
        ),
      },
      artifacts: [],
      delta_refs: [],
    };
    const synthResult = await bus.dispatch(synthEnvelope);

    if (synthResult.exitCode !== 0) {
      await fail(
        journal,
        runId,
        `orchestrator (synthesis) exited with code ${synthResult.exitCode}`,
        synthResult.stderrExcerpt,
      );
      return;
    }

    const synthDecision = parseDecision(synthResult);
    const summary =
      synthDecision?.action === 'reply' ? synthDecision.message : synthResult.responseText;
    process.stdout.write(summary.trimEnd() + '\n');
    if (synthDecision?.action !== 'reply') {
      process.stderr.write(
        `(warning: orchestrator synthesis returned no parseable {action:'reply'} block)\n`,
      );
    }
    await journal.closeRun(runId, 'succeeded');
    console.error(`(run_id: ${runId})`);
  } catch (err) {
    if (worktree) await finalizeWorktree(project, worktree).catch(() => undefined);
    if (err instanceof BudgetExhausted) {
      process.stderr.write(`(${err.message}; halting Run)\n`);
    }
    await journal.closeRun(runId, 'failed').catch(() => undefined);
    throw err;
  }
}

function buildSynthesisPrompt(
  intent: string,
  runId: string,
  plan: unknown,
  executions: TaskExecution[],
  memoryContext: MemoryRecord[],
  memoryRecordsProposed: NewMemoryRecord[],
  gate: {
    gateFailed: boolean;
    worktree?: WorktreeOutcome;
    consistency?: ConsistencyReport;
  },
): string {
  const taskResults = executions.map((e) => ({
    task_id: e.task.id,
    owner: e.task.owner,
    status: e.status,
    skip_reason: e.skip_reason,
    attempts: e.attempts,
    response: e.response,
    verification: e.verification,
  }));
  return [
    'SYNTHESIS REQUEST',
    '',
    `run_id: ${runId}`,
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
    'consistency_gate (Cross-Artifact Consistency check, SPEC §4.8):',
    JSON.stringify(
      {
        status: gate.consistency?.status ?? 'not-run',
        issues: gate.consistency?.issues ?? [],
      },
      null,
      2,
    ),
    '',
    'verification_gate:',
    JSON.stringify(
      {
        gate_failed: gate.gateFailed,
        worktree_branch: gate.worktree?.branch ?? null,
        worktree_committed: gate.worktree?.committed ?? false,
        worktree_changed_files: gate.worktree?.changedFiles ?? 0,
      },
      null,
      2,
    ),
    '',
    `memory_records_proposed (staged as deltas — fold with \`hira runs approve ${runId}\`):`,
    JSON.stringify(
      memoryRecordsProposed.map((r) => ({ kind: r.kind, title: r.title })),
      null,
      2,
    ),
    '',
    'Compose the user-facing reply per your synthesis rules.',
  ].join('\n');
}

/**
 * Dispatch the Memory Maintainer and stage its proposed records as this
 * Run's memory delta (SPEC §4.8). Records do NOT touch baseline memory
 * here — `hira runs approve` folds them in. Returns the proposed records
 * so the synthesis can announce them.
 */
async function runMemoryMaintainer(args: {
  bus: Bus;
  journal: Journal;
  runDir: string;
  runId: string;
  parentHandoffId: string;
  intent: string;
  plan: unknown;
  executions: TaskExecution[];
}): Promise<NewMemoryRecord[]> {
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
      `(warning: memory maintainer exited ${result.exitCode}; no records proposed for this Run)\n`,
    );
    return [];
  }

  const proposed = parseMemoryRecords(result.response);
  const validated: NewMemoryRecord[] = [];
  for (const r of proposed) {
    const parsedRecord = NewMemoryRecordSchema.safeParse({
      ...(r as object),
      source: { run_id: args.runId, handoff_id: envelope.handoff_id },
    });
    if (parsedRecord.success) {
      validated.push(parsedRecord.data);
    } else {
      process.stderr.write(
        `(warning: skipping malformed memory record: ${parsedRecord.error.message})\n`,
      );
    }
  }

  if (validated.length > 0) {
    await writeMemoryDelta(args.runDir, validated);
  }
  return validated;
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
