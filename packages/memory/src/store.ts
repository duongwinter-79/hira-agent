import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MemoryRecordSchema,
  NewMemoryRecordSchema,
  type MemoryKind,
  type MemoryRecord,
  type NewMemoryRecord,
} from './types.js';

/**
 * Append-only JSONL store at `.hira/memory/records.jsonl`.
 *
 * Single-writer, project-scoped. Read paths replay the file; write paths
 * append a single line. Stays simple while we measure recall in real Runs;
 * SQLite + FTS5 (or vector index) lands once we feel the cost (SPEC §10).
 *
 * Public API is storage-agnostic so the backend can swap without touching
 * the runtime or CLI.
 */
export class MemoryStore {
  private readonly recordsPath: string;
  private readonly memoryDir: string;
  /** Per-kind monotonic sequence counters for stable ids. */
  private readonly seqByKind = new Map<MemoryKind, number>();
  private cache: MemoryRecord[] | null = null;

  constructor(projectRoot: string) {
    this.memoryDir = join(projectRoot, '.hira', 'memory');
    this.recordsPath = join(this.memoryDir, 'records.jsonl');
  }

  /** Append a new record. */
  async write(input: NewMemoryRecord): Promise<MemoryRecord> {
    const parsed = NewMemoryRecordSchema.parse(input);
    await mkdir(this.memoryDir, { recursive: true });
    await this.warmCache();

    const seq = (this.seqByKind.get(parsed.kind) ?? 0) + 1;
    this.seqByKind.set(parsed.kind, seq);
    const now = new Date().toISOString();
    const record: MemoryRecord = {
      ...parsed,
      id: `${parsed.kind}:${seq}`,
      created_at: now,
      updated_at: now,
    };
    await appendFile(this.recordsPath, JSON.stringify(record) + '\n', 'utf8');
    this.cache?.push(record);
    return record;
  }

  /**
   * Return all records, optionally filtered, newest first.
   *
   * The cache is in append (chronological) order, so "newest first" is a
   * stable reverse — no `created_at` sort, which would tie and reorder
   * unpredictably when several records are written in the same millisecond.
   */
  async list(filters: { kind?: MemoryKind; tags?: string[] } = {}): Promise<MemoryRecord[]> {
    await this.warmCache();
    let out = this.cache ?? [];
    if (filters.kind) out = out.filter((r) => r.kind === filters.kind);
    if (filters.tags && filters.tags.length > 0) {
      const wanted = new Set(filters.tags.map((t) => t.toLowerCase()));
      out = out.filter((r) => r.tags.some((t) => wanted.has(t.toLowerCase())));
    }
    return [...out].reverse();
  }

  /** Get one record by id. */
  async get(id: string): Promise<MemoryRecord | undefined> {
    await this.warmCache();
    return (this.cache ?? []).find((r) => r.id === id);
  }

  /**
   * Keyword query: simple per-term hit count with field weighting
   * (tags×3, title×2, body×1). Good enough for ~hundreds of records;
   * swap to FTS5 / vector index when we measure recall problems.
   */
  async query(text: string, limit = 5): Promise<MemoryRecord[]> {
    await this.warmCache();
    const terms = tokenise(text);
    if (terms.length === 0) return [];
    const scored: { record: MemoryRecord; score: number }[] = [];
    // Iterate newest-first so that, after a stable sort by score, records
    // with equal scores stay in newest-first order.
    for (const r of [...(this.cache ?? [])].reverse()) {
      let score = 0;
      const tagBag = r.tags.map((t) => t.toLowerCase()).join(' ');
      const titleLc = r.title.toLowerCase();
      const bodyLc = r.body.toLowerCase();
      for (const t of terms) {
        if (tagBag.includes(t)) score += 3;
        if (titleLc.includes(t)) score += 2;
        if (bodyLc.includes(t)) score += 1;
      }
      if (score > 0) scored.push({ record: r, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.record);
  }

  /** Drop the in-memory cache so the next read re-scans disk. Used by tests. */
  invalidate(): void {
    this.cache = null;
    this.seqByKind.clear();
  }

  private async warmCache(): Promise<void> {
    if (this.cache !== null) return;
    const records: MemoryRecord[] = [];
    const raw = await readFile(this.recordsPath, 'utf8').catch(() => null);
    if (raw !== null) {
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parsed = MemoryRecordSchema.safeParse(JSON.parse(trimmed));
        if (parsed.success) {
          records.push(parsed.data);
          const kind = parsed.data.kind;
          const seq = Number.parseInt(parsed.data.id.split(':')[1] ?? '0', 10);
          if (seq > (this.seqByKind.get(kind) ?? 0)) {
            this.seqByKind.set(kind, seq);
          }
        }
      }
    }
    this.cache = records;
  }
}

function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter((t) => t.length >= 2);
}
