import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from './store.js';

async function tmpRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'hira-memory-'));
}

describe('MemoryStore', () => {
  it('writes and retrieves a record with a stable {kind}:{seq} id', async () => {
    const root = await tmpRoot();
    const store = new MemoryStore(root);

    const a = await store.write({
      kind: 'adr',
      title: 'Use Redis token bucket',
      body: 'Decision: per-IP token bucket backed by Redis...',
      tags: ['rate-limit', 'auth'],
    });
    expect(a.id).toBe('adr:1');
    expect(a.created_at).toBeTruthy();

    const fetched = await store.get('adr:1');
    expect(fetched).toEqual(a);
  });

  it('mints monotonic sequence per kind', async () => {
    const root = await tmpRoot();
    const store = new MemoryStore(root);
    const a = await store.write({ kind: 'adr', title: 'a', body: 'b', tags: [] });
    const b = await store.write({ kind: 'adr', title: 'a2', body: 'b2', tags: [] });
    const c = await store.write({ kind: 'outcome', title: 'o1', body: 'b3', tags: [] });
    expect(a.id).toBe('adr:1');
    expect(b.id).toBe('adr:2');
    expect(c.id).toBe('outcome:1');
  });

  it('persists across instances (rehydrates seq counter from disk)', async () => {
    const root = await tmpRoot();
    const s1 = new MemoryStore(root);
    await s1.write({ kind: 'adr', title: 'first', body: 'b', tags: [] });
    await s1.write({ kind: 'adr', title: 'second', body: 'b', tags: [] });

    const s2 = new MemoryStore(root);
    const next = await s2.write({ kind: 'adr', title: 'third', body: 'b', tags: [] });
    expect(next.id).toBe('adr:3');

    const all = await s2.list({ kind: 'adr' });
    expect(all.map((r) => r.title)).toEqual(['third', 'second', 'first']);
  });

  it('list() filters by kind and tags', async () => {
    const root = await tmpRoot();
    const store = new MemoryStore(root);
    await store.write({ kind: 'adr', title: 'a', body: 'b', tags: ['auth'] });
    await store.write({ kind: 'outcome', title: 'o', body: 'b', tags: ['auth'] });
    await store.write({ kind: 'adr', title: 'a2', body: 'b', tags: ['db'] });

    const adrs = await store.list({ kind: 'adr' });
    expect(adrs.map((r) => r.title)).toEqual(['a2', 'a']);

    const auth = await store.list({ tags: ['auth'] });
    expect(auth.map((r) => r.title).sort()).toEqual(['a', 'o']);
  });

  it('query() ranks by tag>title>body, returns top N', async () => {
    const root = await tmpRoot();
    const store = new MemoryStore(root);
    await store.write({
      kind: 'adr',
      title: 'Use Redis token bucket for rate limiting',
      body: 'lots of body text...',
      tags: ['rate-limit'],
    });
    await store.write({
      kind: 'adr',
      title: 'Database choice',
      body: 'We considered rate limiting once but skipped.',
      tags: ['db'],
    });
    await store.write({
      kind: 'outcome',
      title: 'unrelated thing',
      body: 'nothing here',
      tags: ['misc'],
    });

    const hits = await store.query('rate limit', 5);
    expect(hits.map((r) => r.title)).toEqual([
      'Use Redis token bucket for rate limiting',
      'Database choice',
    ]);
  });

  it('query() returns [] when no terms match', async () => {
    const root = await tmpRoot();
    const store = new MemoryStore(root);
    await store.write({ kind: 'adr', title: 'a', body: 'b', tags: ['x'] });
    expect(await store.query('something completely different', 5)).toEqual([]);
  });

  it('validates record shape; rejects empty title', async () => {
    const root = await tmpRoot();
    const store = new MemoryStore(root);
    await expect(
      store.write({ kind: 'adr', title: '', body: 'b', tags: [] }),
    ).rejects.toThrow();
  });

  it('list() on an empty store returns []', async () => {
    const root = await tmpRoot();
    const store = new MemoryStore(root);
    expect(await store.list()).toEqual([]);
  });
});
