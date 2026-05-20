import { describe, it, expect } from 'vitest';
import type { Artifact, HandoffRecord, RunRecord } from '@hira/journal';
import { buildRunTrace, traceArtifact } from './trace.js';

const run: RunRecord = {
  id: 'run-1234abcd',
  intent_message: 'add a rate limiter',
  started_at: '2026-05-20T00:00:00Z',
  status: 'succeeded',
};

function handoff(partial: Partial<HandoffRecord> & { handoff_id: string }): HandoffRecord {
  return {
    run_id: run.id,
    from: 'orchestrator',
    to: 'developer',
    kind: 'request',
    payload: {},
    artifacts: [],
    delta_refs: [],
    status: 'completed',
    started_at: '2026-05-20T00:00:00Z',
    ...partial,
  };
}

const plannerResponse = {
  tasks: [
    { id: 't1', owner: 'knowledge', depends_on: [] },
    { id: 't2', owner: 'solution-architect', depends_on: ['t1'] },
    { id: 't3', owner: 'developer', depends_on: ['t2'] },
    { id: 't4', owner: 'reviewer', depends_on: ['t3'] },
  ],
};

const handoffs: HandoffRecord[] = [
  handoff({ handoff_id: 'h-classify', from: 'user', to: 'orchestrator' }),
  handoff({ handoff_id: 'h-plan', to: 'planner', response: plannerResponse }),
  handoff({ handoff_id: 'h-t1', to: 'knowledge', task_id: 't1' }),
  handoff({ handoff_id: 'h-t2', to: 'solution-architect', task_id: 't2' }),
  handoff({ handoff_id: 'h-t3', to: 'developer', task_id: 't3' }),
  handoff({ handoff_id: 'h-t4', to: 'reviewer', task_id: 't4' }),
  handoff({ handoff_id: 'h-synth', from: 'user', to: 'orchestrator', kind: 'response' }),
];

const verificationArtifact: Artifact = {
  id: 'verification:run-1234:1',
  kind: 'verification',
  payload: { status: 'pass' },
  handoff_id: 'h-t3',
};

describe('buildRunTrace', () => {
  it('annotates Planner tasks with their executing hand-offs', () => {
    const trace = buildRunTrace(run, handoffs, [verificationArtifact]);
    expect(trace.tasks.map((t) => t.id)).toEqual(['t1', 't2', 't3', 't4']);
    const t3 = trace.tasks.find((t) => t.id === 't3')!;
    expect(t3.owner).toBe('developer');
    expect(t3.handoff_id).toBe('h-t3');
    expect(t3.status).toBe('completed');
    expect(t3.artifacts).toHaveLength(1);
    expect(t3.artifacts[0]!.id).toBe('verification:run-1234:1');
  });

  it('separates framing hand-offs (classify / plan / synthesis) from task hand-offs', () => {
    const trace = buildRunTrace(run, handoffs, []);
    expect(trace.framing.map((f) => f.handoff_id).sort()).toEqual([
      'h-classify',
      'h-plan',
      'h-synth',
    ]);
  });

  it('counts retries as attempts on the task', () => {
    const withRetry = [
      ...handoffs,
      handoff({ handoff_id: 'h-t3-retry', to: 'developer', task_id: 't3' }),
    ];
    const trace = buildRunTrace(run, withRetry, []);
    const t3 = trace.tasks.find((t) => t.id === 't3')!;
    expect(t3.attempts).toBe(2);
    expect(t3.handoff_id).toBe('h-t3-retry'); // last attempt
  });

  it('returns no tasks for a Run with no planner hand-off (direct reply)', () => {
    const trace = buildRunTrace(run, [handoffs[0]!], []);
    expect(trace.tasks).toEqual([]);
  });
});

describe('traceArtifact', () => {
  it('walks backward to ancestors and forward to descendants', () => {
    const trace = buildRunTrace(run, handoffs, [verificationArtifact]);
    const at = traceArtifact(trace, 'verification:run-1234:1');
    expect(at).toBeDefined();
    expect(at!.task!.id).toBe('t3');
    // t3 depends on t2 which depends on t1 → ancestors t1, t2.
    expect(at!.ancestors.map((t) => t.id)).toEqual(['t1', 't2']);
    // t4 depends on t3 → descendant t4.
    expect(at!.descendants.map((t) => t.id)).toEqual(['t4']);
  });

  it('returns undefined for an unknown artifact id', () => {
    const trace = buildRunTrace(run, handoffs, [verificationArtifact]);
    expect(traceArtifact(trace, 'nope:run-1234:9')).toBeUndefined();
  });
});
