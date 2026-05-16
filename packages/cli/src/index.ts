import { Command } from 'commander';
import { resolve } from 'node:path';
import { loadPlugins } from '@hira/runtime';

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

await program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
