import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '@hira/memory';
import { runSpecConsistencyTool } from './spec-consistency.js';

async function tmpProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'hira-mcp-'));
}

const goodTasks = [
  { id: 't1', description: 'research', owner: 'knowledge', depends_on: [] },
  { id: 't2', description: 'build', owner: 'developer', depends_on: ['t1'] },
];

describe('runSpecConsistencyTool', () => {
  it('passes a clean plan against an empty memory store', async () => {
    const root = await tmpProject();
    const report = await runSpecConsistencyTool({ tasks: goodTasks }, root);
    expect(report.status).toBe('pass');
  });

  it('blocks a plan with an unknown owner (default Hira roster)', async () => {
    const root = await tmpProject();
    const report = await runSpecConsistencyTool(
      { tasks: [{ id: 't1', description: 'x', owner: 'wizard', depends_on: [] }] },
      root,
    );
    expect(report.status).toBe('blocked');
    expect(report.issues.some((i) => i.kind === 'unknown-owner')).toBe(true);
  });

  it('warns when the ADR overlaps a baseline decision in the memory store', async () => {
    const root = await tmpProject();
    const store = new MemoryStore(root);
    await store.write({
      kind: 'adr',
      title: 'Redis token bucket for rate limiting',
      body: 'prior decision',
      tags: ['redis', 'rate-limit'],
    });

    const report = await runSpecConsistencyTool(
      {
        tasks: goodTasks,
        adr: { title: 'Use Redis token bucket rate limiter', tags: ['redis', 'rate-limit'] },
      },
      root,
    );
    expect(report.status).toBe('warnings');
    expect(report.issues[0]!.kind).toBe('related-prior-decision');
  });

  it('honours a custom known_owners roster', async () => {
    const root = await tmpProject();
    const report = await runSpecConsistencyTool(
      {
        tasks: [{ id: 't1', description: 'x', owner: 'custom-agent', depends_on: [] }],
        known_owners: ['custom-agent'],
      },
      root,
    );
    expect(report.status).toBe('pass');
  });
});
