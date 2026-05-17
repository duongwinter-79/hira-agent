import { Command } from 'commander';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  Bus,
  Journal,
  SessionDriver,
  composeSystemPrompt,
  loadBehaviouralSkills,
  loadPlugins,
  type Handoff,
  type LoadedAgent,
  type LoadedSkill,
} from '@hira/runtime';

const program = new Command();
program.name('hira').description('Hira multi-agent orchestrator').version('0.0.1');

// ---------- agents ----------

const agents = program.command('agents').description('Inspect configured agents');

agents
  .command('list')
  .description('List configured agents')
  .option('--root <path>', 'project root', process.cwd())
  .action(async (opts: { root: string }) => {
    const { agents } = await loadPlugins(resolve(opts.root));
    if (agents.length === 0) {
      console.log('(no agents found)');
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
  .description('Run the Orchestrator on a single user message (may dispatch to Planner)')
  .argument('<message>', 'the user message to send to the Orchestrator')
  .option('--root <path>', 'project root', process.cwd())
  .option('--dry-run', 'print the assembled claude invocation without spawning')
  .option('--binary <path>', 'path to the claude CLI binary', 'claude')
  .action(
    async (
      message: string,
      opts: { root: string; dryRun?: boolean; binary: string },
    ) => {
      const root = resolve(opts.root);
      const { agents, skills } = await loadPlugins(root);
      const orchestrator = agents.find(
        (a: LoadedAgent) => a.manifest.name === 'orchestrator',
      );
      if (!orchestrator) {
        console.error('No agent named "orchestrator" found under plugins/agents/.');
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
          cwd: root,
          sessionId: randomUUID(),
          noSessionPersistence: true,
          outputFormat: 'stream-json',
          settingSources: [],
        });
        console.log(dry.display);
        return;
      }

      const journal = new Journal(root);
      const run = await journal.openRun(message);
      const driver = new SessionDriver();
      const bus = new Bus({
        agents,
        skills,
        journal,
        projectRoot: root,
        driver,
        binary: opts.binary,
      });

      try {
        // Hand-off 1: user → orchestrator (intent classification)
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
          fail(journal, run.id, `orchestrator exited with code ${orcResult.exitCode}`, orcResult.stderrExcerpt);
          return;
        }

        const decision = parseDecision(orcResult);
        if (!decision) {
          // Orchestrator didn't follow the contract; fall back to its raw text.
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

        // Hand-off 2: orchestrator → planner
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
          fail(
            journal,
            run.id,
            `${decision.target} exited with code ${planResult.exitCode}`,
            planResult.stderrExcerpt,
          );
          return;
        }

        // M1.2: surface the plan to the user. M1.3 will add a synthesis pass
        // through the orchestrator that turns the structured plan into prose.
        process.stdout.write(`Dispatched to ${decision.target}. Plan:\n`);
        if (planResult.response !== null) {
          process.stdout.write(JSON.stringify(planResult.response, null, 2) + '\n');
        } else {
          process.stdout.write(planResult.responseText.trimEnd() + '\n');
          process.stderr.write(
            `(warning: ${decision.target} output had no parseable fenced JSON)\n`,
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
  .description('List recent Runs')
  .option('--root <path>', 'project root', process.cwd())
  .option('--limit <n>', 'maximum runs to show', (v) => Number.parseInt(v, 10), 20)
  .action(async (opts: { root: string; limit: number }) => {
    const journal = new Journal(resolve(opts.root));
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
  .option('--root <path>', 'project root', process.cwd())
  .action(async (runId: string, opts: { root: string }) => {
    const journal = new Journal(resolve(opts.root));
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

await program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

// ---------- helpers ----------

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

