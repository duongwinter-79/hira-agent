import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NewMemoryRecord } from '@hira/memory';
import { writeMemoryDelta, readMemoryDelta } from './delta.js';

async function tmpRunDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'hira-delta-'));
}

const records: NewMemoryRecord[] = [
  { kind: 'adr', title: 'Use a worktree', body: 'Decision body', tags: ['git'] },
  { kind: 'outcome', title: 'Retry once', body: 'Lesson body', tags: ['dev'] },
];

describe('memory delta', () => {
  it('writes the delta under deltas/memory.json', async () => {
    const runDir = await tmpRunDir();
    const path = await writeMemoryDelta(runDir, records);
    expect(path).toBe(join(runDir, 'deltas', 'memory.json'));
    const raw = JSON.parse(await readFile(path, 'utf8'));
    expect(raw.records).toHaveLength(2);
  });

  it('round-trips records through write then read', async () => {
    const runDir = await tmpRunDir();
    await writeMemoryDelta(runDir, records);
    const back = await readMemoryDelta(runDir);
    expect(back).toEqual(records);
  });

  it('returns [] when there is no delta file', async () => {
    const runDir = await tmpRunDir();
    expect(await readMemoryDelta(runDir)).toEqual([]);
  });

  it('drops records that fail schema validation', async () => {
    const runDir = await tmpRunDir();
    // Bypass writeMemoryDelta to plant a malformed record alongside a good one.
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(runDir, 'deltas'), { recursive: true });
    await writeFile(
      join(runDir, 'deltas', 'memory.json'),
      JSON.stringify({
        records: [
          { kind: 'adr', title: 'good', body: 'b', tags: [] },
          { kind: 'not-a-kind', title: 'bad', body: 'b' },
        ],
      }),
    );
    const back = await readMemoryDelta(runDir);
    expect(back).toHaveLength(1);
    expect(back[0]!.title).toBe('good');
  });
});
