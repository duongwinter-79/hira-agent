import { Command } from 'commander';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  loadPlugins,
  SessionDriver,
  type LoadedAgent,
  type SessionInvocation,
} from '@hira/runtime';

const program = new Command();
program.name('hira').description('Hira multi-agent orchestrator').version('0.0.1');

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

program
  .command('run')
  .description('Run the Orchestrator on a single user message (M0.2: no hand-offs yet)')
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
      const { agents } = await loadPlugins(root);
      const orchestrator = agents.find(
        (a: LoadedAgent) => a.manifest.name === 'orchestrator',
      );
      if (!orchestrator) {
        console.error('No agent named "orchestrator" found under plugins/agents/.');
        process.exit(1);
      }

      const invocation: SessionInvocation = {
        binary: opts.binary,
        prompt: message,
        systemPrompt: orchestrator.systemPrompt,
        allowedTools: orchestrator.manifest.tools,
        permissionMode: 'acceptEdits',
        cwd: root,
        sessionId: randomUUID(),
        noSessionPersistence: true,
        outputFormat: 'stream-json',
      };

      const driver = new SessionDriver();

      if (opts.dryRun) {
        const dry = driver.dryRun(invocation);
        console.log(dry.display);
        return;
      }

      const result = await driver.run(invocation);
      if (result.exitCode !== 0) {
        console.error(`claude exited with code ${result.exitCode}`);
        if (result.stderr) console.error(result.stderr.trimEnd());
        process.exit(result.exitCode || 1);
      }
      process.stdout.write(result.text.trimEnd() + '\n');
    },
  );

await program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
