import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from './journal.js';
import { HandoffSchema, type Handoff } from './types.js';

async function tmpRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'hira-journal-'));
}

function makeHandoff(runId: string, overrides: Partial<Handoff> = {}): Handoff {
  return HandoffSchema.parse({
    run_id: runId,
    handoff_id: 'h-1',
    from: 'user',
    to: 'orchestrator',
    kind: 'request',
    payload: { message: 'hi' },
    ...overrides,
  });
}

describe('Journal', () => {
  it('opens, records, and closes a Run', async () => {
    const root = await tmpRoot();
    const j = new Journal(root);

    const run = await j.openRun('Plan a feature');
    expect(run.status).toBe('running');
    expect(run.id).toBeTruthy();

    const h = makeHandoff(run.id);
    await j.recordHandoffStart(h);
    await j.completeHandoff(run.id, h.handoff_id, {
      status: 'completed',
      session_id: 'sess-1',
      response_text: 'ok',
      exit_code: 0,
    });
    await j.closeRun(run.id, 'succeeded');

    const fetched = await j.getRun(run.id);
    expect(fetched).toBeDefined();
    expect(fetched!.run.status).toBe('succeeded');
    expect(fetched!.handoffs).toHaveLength(1);
    expect(fetched!.handoffs[0]!.status).toBe('completed');
    expect(fetched!.handoffs[0]!.session_id).toBe('sess-1');
    expect(fetched!.handoffs[0]!.response_text).toBe('ok');
  });

  it('returns undefined for unknown run ids', async () => {
    const root = await tmpRoot();
    const j = new Journal(root);
    expect(await j.getRun('does-not-exist')).toBeUndefined();
  });

  it('lists runs newest first', async () => {
    const root = await tmpRoot();
    const j = new Journal(root);
    const a = await j.openRun('first');
    await new Promise((r) => setTimeout(r, 5));
    const b = await j.openRun('second');
    const runs = await j.listRuns();
    expect(runs.map((r) => r.id)).toEqual([b.id, a.id]);
  });

  it('mints stable artifact IDs with monotonic seq per kind', async () => {
    const root = await tmpRoot();
    const j = new Journal(root);
    const run = await j.openRun('x');
    const a = await j.recordArtifact(run.id, 'patch', { diff: '...' });
    const b = await j.recordArtifact(run.id, 'patch', { diff: '...' });
    const c = await j.recordArtifact(run.id, 'adr', { decision: '...' });
    expect(a.id).toBe(`patch:${run.id.slice(0, 8)}:1`);
    expect(b.id).toBe(`patch:${run.id.slice(0, 8)}:2`);
    expect(c.id).toBe(`adr:${run.id.slice(0, 8)}:1`);
  });

  it('Handoff envelope accepts forward-compat fields (verification + deltas)', () => {
    const parsed = HandoffSchema.parse({
      run_id: 'r1',
      handoff_id: 'h1',
      from: 'developer',
      to: 'reviewer',
      kind: 'review',
      payload: {},
      artifacts: [],
      verification_report: {
        status: 'pass',
        stages: [{ name: 'tests', status: 'pass' }],
      },
      delta_refs: ['delta:r1:1'],
    });
    expect(parsed.verification_report?.status).toBe('pass');
    expect(parsed.delta_refs).toEqual(['delta:r1:1']);
  });

  it('Handoff envelope defaults artifacts and delta_refs to []', () => {
    const parsed = HandoffSchema.parse({
      run_id: 'r1',
      handoff_id: 'h1',
      from: 'a',
      to: 'b',
      kind: 'request',
      payload: {},
    });
    expect(parsed.artifacts).toEqual([]);
    expect(parsed.delta_refs).toEqual([]);
    expect(parsed.verification_report).toBeUndefined();
  });
});
