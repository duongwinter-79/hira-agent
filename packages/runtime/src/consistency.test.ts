import { describe, it, expect } from 'vitest';
import { checkConsistency, type ConsistencyTask } from './consistency.js';

const owners = new Set(['knowledge', 'solution-architect', 'developer', 'tester', 'reviewer']);

const goodTasks: ConsistencyTask[] = [
  { id: 't1', description: 'research', owner: 'knowledge', depends_on: [] },
  { id: 't2', description: 'design', owner: 'solution-architect', depends_on: ['t1'] },
  { id: 't3', description: 'build', owner: 'developer', depends_on: ['t2'] },
];

describe('checkConsistency', () => {
  it('passes a well-formed plan', () => {
    const report = checkConsistency({ tasks: goodTasks, baselineAdrs: [], knownOwners: owners });
    expect(report.status).toBe('pass');
    expect(report.issues).toEqual([]);
  });

  it('blocks an empty plan', () => {
    const report = checkConsistency({ tasks: [], baselineAdrs: [], knownOwners: owners });
    expect(report.status).toBe('blocked');
    expect(report.issues[0]!.kind).toBe('no-tasks');
  });

  it('blocks an unknown owner', () => {
    const tasks: ConsistencyTask[] = [
      { id: 't1', description: 'x', owner: 'frontend-wizard', depends_on: [] },
    ];
    const report = checkConsistency({ tasks, baselineAdrs: [], knownOwners: owners });
    expect(report.status).toBe('blocked');
    expect(report.issues.some((i) => i.kind === 'unknown-owner')).toBe(true);
  });

  it('blocks an empty task description', () => {
    const tasks: ConsistencyTask[] = [
      { id: 't1', description: '   ', owner: 'developer', depends_on: [] },
    ];
    const report = checkConsistency({ tasks, baselineAdrs: [], knownOwners: owners });
    expect(report.issues.some((i) => i.kind === 'empty-description')).toBe(true);
    expect(report.status).toBe('blocked');
  });

  it('blocks a dangling dependency', () => {
    const tasks: ConsistencyTask[] = [
      { id: 't1', description: 'x', owner: 'developer', depends_on: ['ghost'] },
    ];
    const report = checkConsistency({ tasks, baselineAdrs: [], knownOwners: owners });
    expect(report.issues.some((i) => i.kind === 'dangling-dependency')).toBe(true);
    expect(report.status).toBe('blocked');
  });

  it('blocks a dependency cycle', () => {
    const tasks: ConsistencyTask[] = [
      { id: 'a', description: 'x', owner: 'developer', depends_on: ['b'] },
      { id: 'b', description: 'y', owner: 'developer', depends_on: ['a'] },
    ];
    const report = checkConsistency({ tasks, baselineAdrs: [], knownOwners: owners });
    expect(report.issues.some((i) => i.kind === 'cycle')).toBe(true);
  });

  it('does not mistake a dangling dependency for a cycle', () => {
    const tasks: ConsistencyTask[] = [
      { id: 't1', description: 'x', owner: 'developer', depends_on: ['ghost'] },
    ];
    const report = checkConsistency({ tasks, baselineAdrs: [], knownOwners: owners });
    expect(report.issues.some((i) => i.kind === 'cycle')).toBe(false);
  });

  it('warns when a new ADR overlaps a baseline decision', () => {
    const report = checkConsistency({
      tasks: goodTasks,
      knownOwners: owners,
      adr: { title: 'Use Redis token bucket rate limiter', tags: ['redis', 'rate-limit'] },
      baselineAdrs: [
        {
          id: 'adr:1',
          title: 'Redis token bucket for rate limiting',
          tags: ['redis', 'rate-limit'],
        },
      ],
    });
    expect(report.status).toBe('warnings');
    expect(report.issues[0]!.kind).toBe('related-prior-decision');
    expect(report.issues[0]!.message).toContain('adr:1');
  });

  it('does not warn for an unrelated ADR', () => {
    const report = checkConsistency({
      tasks: goodTasks,
      knownOwners: owners,
      adr: { title: 'Adopt structured logging', tags: ['logging'] },
      baselineAdrs: [
        { id: 'adr:1', title: 'Redis token bucket', tags: ['redis', 'rate-limit'] },
      ],
    });
    expect(report.status).toBe('pass');
  });
});
