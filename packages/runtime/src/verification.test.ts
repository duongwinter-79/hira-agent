import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '@hira/journal';
import {
  loadVerificationConfig,
  runVerificationEngine,
  verifyDeveloperHandoff,
} from './verification.js';
import type { TaskExecution } from './executor.js';

async function tmpRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'hira-ver-'));
}

const devExec: TaskExecution = {
  task: { id: 't', description: 'impl', owner: 'developer', depends_on: [] },
  handoff_id: 'h-dev',
  status: 'completed',
  response: { summary: 'did the thing' },
};

describe('loadVerificationConfig', () => {
  it('returns null when hira.config.json is absent', async () => {
    const root = await tmpRoot();
    expect(await loadVerificationConfig(root)).toBeNull();
  });

  it('returns null on malformed JSON', async () => {
    const root = await tmpRoot();
    await writeFile(join(root, 'hira.config.json'), '{ not json');
    expect(await loadVerificationConfig(root)).toBeNull();
  });

  it('returns null when there is no verification block', async () => {
    const root = await tmpRoot();
    await writeFile(join(root, 'hira.config.json'), JSON.stringify({ other: true }));
    expect(await loadVerificationConfig(root)).toBeNull();
  });

  it('parses valid checks and drops malformed entries', async () => {
    const root = await tmpRoot();
    await writeFile(
      join(root, 'hira.config.json'),
      JSON.stringify({
        verification: {
          checks: [
            { name: 'test', command: 'pnpm test' },
            { name: 'no-command' },
            { command: 'no-name' },
            { name: 'lint', command: 'eslint .', timeout_ms: 1000 },
          ],
        },
      }),
    );
    const config = await loadVerificationConfig(root);
    expect(config?.checks).toEqual([
      { name: 'test', command: 'pnpm test' },
      { name: 'lint', command: 'eslint .', timeout_ms: 1000 },
    ]);
  });
});

describe('runVerificationEngine', () => {
  it('reports skipped when config is null', async () => {
    const root = await tmpRoot();
    const report = await runVerificationEngine({ projectRoot: root, config: null });
    expect(report.status).toBe('skipped');
    expect(report.stages[0]!.name).toBe('config');
  });

  it('reports pass when every check exits 0', async () => {
    const root = await tmpRoot();
    const report = await runVerificationEngine({
      projectRoot: root,
      config: {
        checks: [
          { name: 'a', command: 'exit 0' },
          { name: 'b', command: 'true' },
        ],
      },
    });
    expect(report.status).toBe('pass');
    expect(report.stages.every((s) => s.status === 'pass')).toBe(true);
  });

  it('reports fail when any check exits non-zero, and runs them all', async () => {
    const root = await tmpRoot();
    const report = await runVerificationEngine({
      projectRoot: root,
      config: {
        checks: [
          { name: 'a', command: 'exit 0' },
          { name: 'b', command: 'exit 3' },
          { name: 'c', command: 'exit 0' },
        ],
      },
    });
    expect(report.status).toBe('fail');
    expect(report.stages.map((s) => s.status)).toEqual(['pass', 'fail', 'pass']);
  });

  it('captures command output into the stage', async () => {
    const root = await tmpRoot();
    const report = await runVerificationEngine({
      projectRoot: root,
      config: { checks: [{ name: 'echoer', command: 'echo HIRA_MARKER' }] },
    });
    expect(report.stages[0]!.output).toContain('HIRA_MARKER');
  });
});

describe('verifyDeveloperHandoff', () => {
  it('runs the engine and records a verification artifact on the dev hand-off', async () => {
    const root = await tmpRoot();
    const journal = new Journal(root);
    const run = await journal.openRun('test');

    const report = await verifyDeveloperHandoff(devExec, {
      journal,
      runId: run.id,
      parentHandoffId: 'h-dev',
      projectRoot: root,
      config: { checks: [{ name: 'ok', command: 'exit 0' }] },
    });

    expect(report.status).toBe('pass');
    const data = await journal.getRun(run.id);
    const ver = data!.artifacts.filter((a) => a.kind === 'verification');
    expect(ver).toHaveLength(1);
    expect(ver[0]!.handoff_id).toBe('h-dev');
  });
});
