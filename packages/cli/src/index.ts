import { Command } from 'commander';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  Journal,
  SessionDriver,
  composeSystemPrompt,
  loadBehaviouralSkills,
  loadPlugins,
  prepareAgentIsolation,
  type Handoff,
  type LoadedAgent,
  type LoadedSkill,
  type SessionInvocation,
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
  .description('Run the Orchestrator on a single user message')
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

      const systemPrompt = await renderSystemPrompt(orchestrator, skills);

      if (opts.dryRun) {
        const driver = new SessionDriver();
        const dry = driver.dryRun({
          binary: opts.binary,
          prompt: message,
          systemPrompt,
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
      const runDir = journal.runDir(run.id);

      const isolation = await prepareAgentIsolation({
        runDir,
        agentName: orchestrator.manifest.name,
        allowedTools: orchestrator.manifest.tools,
      });

      const handoff: Handoff = {
        run_id: run.id,
        handoff_id: randomUUID(),
        from: 'user',
        to: 'orchestrator',
        kind: 'request',
        payload: { message },
        artifacts: [],
        delta_refs: [],
      };
      await journal.recordHandoffStart(handoff);

      const invocation: SessionInvocation = {
        binary: opts.binary,
        prompt: message,
        systemPrompt,
        allowedTools: orchestrator.manifest.tools,
        permissionMode: 'acceptEdits',
        cwd: root,
        sessionId: randomUUID(),
        noSessionPersistence: true,
        outputFormat: 'stream-json',
        settingSources: [],
        settingsPath: isolation.settingsPath,
      };

      const driver = new SessionDriver();
      const result = await driver.run(invocation);

      await journal.completeHandoff(run.id, handoff.handoff_id, {
        status: result.exitCode === 0 ? 'completed' : 'failed',
        session_id: result.sessionId,
        response_text: result.text,
        exit_code: result.exitCode,
        stderr_excerpt: result.stderr.slice(0, 2048) || undefined,
      });
      await journal.closeRun(run.id, result.exitCode === 0 ? 'succeeded' : 'failed');

      if (result.exitCode !== 0) {
        console.error(`claude exited with code ${result.exitCode}`);
        if (result.stderr) console.error(result.stderr.trimEnd());
        console.error(`(run_id: ${run.id})`);
        process.exit(result.exitCode || 1);
      }
      process.stdout.write(result.text.trimEnd() + '\n');
      console.error(`(run_id: ${run.id})`);
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
      console.log(`  - ${h.handoff_id}  ${h.kind.padEnd(10)} ${arrow}  ${h.status}${dur}`);
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
