import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NewMemoryRecordSchema, type NewMemoryRecord } from '@hira/memory';

/**
 * Spec/ADR delta storage (SPEC §4.8).
 *
 * A Run does not write memory directly. The Memory Maintainer's proposed
 * records are staged as a *delta* under `.hira/runs/<run_id>/deltas/`.
 * They fold into the baseline memory store only when the user approves
 * the Run (`hira runs approve`). An unapproved or rejected Run leaves the
 * baseline untouched.
 */

const MEMORY_DELTA_FILE = 'memory.json';

/** Write the Memory Maintainer's proposed records as this Run's memory delta. */
export async function writeMemoryDelta(
  runDir: string,
  records: NewMemoryRecord[],
): Promise<string> {
  const deltaDir = join(runDir, 'deltas');
  await mkdir(deltaDir, { recursive: true });
  const path = join(deltaDir, MEMORY_DELTA_FILE);
  await writeFile(path, JSON.stringify({ records }, null, 2), 'utf8');
  return path;
}

/**
 * Read a Run's staged memory delta. Returns [] when there is no delta or
 * it is malformed; individual records that fail validation are dropped.
 */
export async function readMemoryDelta(runDir: string): Promise<NewMemoryRecord[]> {
  const path = join(runDir, 'deltas', MEMORY_DELTA_FILE);
  const raw = await readFile(path, 'utf8').catch(() => null);
  if (raw === null) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const records = (parsed as { records?: unknown }).records;
  if (!Array.isArray(records)) return [];

  const out: NewMemoryRecord[] = [];
  for (const r of records) {
    const result = NewMemoryRecordSchema.safeParse(r);
    if (result.success) out.push(result.data);
  }
  return out;
}
