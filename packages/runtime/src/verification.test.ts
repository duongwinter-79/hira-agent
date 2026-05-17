import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '@hira/journal';
import { verifyDeveloperHandoff } from './verification.js';
import type { TaskExecution } from './executor.js';

const devExec: TaskExecution = {
  task: { id: 't', description: 'impl', owner: 'developer', depends_on: [] },
  handoff_id: 'h-dev',
  status: 'completed',
  response: { summary: 'did the thing' },
};

describe('verifyDeveloperHandoff (M1.3 no-op seam)', () => {
  it('returns a skipped report with the three default stages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hira-ver-'));
    const journal = new Journal(root);
    const run = await journal.openRun('test');

    const report = await verifyDeveloperHandoff(devExec, {
      journal,
      runId: run.id,
      parentHandoffId: 'h-dev',
    });

    expect(report.status).toBe('skipped');
    expect(report.stages.map((s) => s.name)).toEqual(['tests', 'typecheck', 'lint']);
    expect(report.stages.every((s) => s.status === 'skipped')).toBe(true);
  });

  it('records a verification artifact attached to the developer hand-off', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hira-ver-'));
    const journal = new Journal(root);
    const run = await journal.openRun('test');

    await verifyDeveloperHandoff(devExec, {
      journal,
      runId: run.id,
      parentHandoffId: 'h-dev',
    });

    const data = await journal.getRun(run.id);
    const ver = data!.artifacts.filter((a) => a.kind === 'verification');
    expect(ver).toHaveLength(1);
    expect(ver[0]!.handoff_id).toBe('h-dev');
    expect((ver[0]!.payload as { status: string }).status).toBe('skipped');
  });
});
