import type { Artifact, HandoffRecord, RunRecord } from '@hira/journal';

/**
 * Bidirectional traceability over the run journal (SPEC §4.9).
 *
 * The journal already records the full chain — intent → Planner task →
 * ADR → Developer patch → Verification → Reviewer verdict. Tracing is a
 * surfacing concern: this module re-projects the journal into a structure
 * walkable from either end (a requirement forward to its consequences, an
 * artifact backward to the requirement that produced it).
 */

/** A Planner task annotated with how it actually executed. */
export type TracedTask = {
  id: string;
  owner: string;
  depends_on: string[];
  /** Status of the task's hand-off; 'not-run' when no matching hand-off exists. */
  status: string;
  /** Hand-off id of the last attempt. */
  handoff_id?: string;
  /** Dispatch count (>1 means the Developer retried). */
  attempts?: number;
  /** Artifacts produced across all attempts of this task. */
  artifacts: Artifact[];
};

/** A non-task hand-off — the framing around the task graph. */
export type FramingHandoff = {
  handoff_id: string;
  from: string;
  to: string;
  kind: string;
  status: string;
};

export type RunTrace = {
  run: RunRecord;
  /** Classify / plan / memory / synthesis hand-offs, in journal order. */
  framing: FramingHandoff[];
  /** The Planner's task graph, each task annotated with its execution. */
  tasks: TracedTask[];
};

/** Re-project journal records into a traceable RunTrace. */
export function buildRunTrace(
  run: RunRecord,
  handoffs: HandoffRecord[],
  artifacts: Artifact[],
): RunTrace {
  const artifactsByHandoff = new Map<string, Artifact[]>();
  for (const a of artifacts) {
    if (!a.handoff_id) continue;
    const list = artifactsByHandoff.get(a.handoff_id) ?? [];
    list.push(a);
    artifactsByHandoff.set(a.handoff_id, list);
  }

  const plannerHandoff = handoffs.find((h) => h.to === 'planner' && h.status === 'completed');
  const plannerTasks = plannerHandoff ? extractTasks(plannerHandoff.response) : [];

  const tasks: TracedTask[] = plannerTasks.map((t) => {
    const taskHandoffs = handoffs.filter((h) => h.task_id === t.id);
    const last = taskHandoffs[taskHandoffs.length - 1];
    return {
      id: t.id,
      owner: t.owner,
      depends_on: t.depends_on,
      status: last?.status ?? 'not-run',
      handoff_id: last?.handoff_id,
      attempts: taskHandoffs.length > 1 ? taskHandoffs.length : undefined,
      artifacts: taskHandoffs.flatMap((h) => artifactsByHandoff.get(h.handoff_id) ?? []),
    };
  });

  const framing: FramingHandoff[] = handoffs
    .filter((h) => !h.task_id)
    .map((h) => ({
      handoff_id: h.handoff_id,
      from: h.from,
      to: h.to,
      kind: h.kind,
      status: h.status,
    }));

  return { run, framing, tasks };
}

export type ArtifactTrace = {
  artifact: Artifact;
  /** The task that produced the artifact, if it came from a task hand-off. */
  task?: TracedTask;
  /** Tasks the producing task transitively depends on (backward), in graph order. */
  ancestors: TracedTask[];
  /** Tasks that transitively depend on the producing task (forward), in graph order. */
  descendants: TracedTask[];
};

/**
 * Walk both directions from an artifact: backward to the requirements that
 * produced it, forward to the work that consumed it. Returns undefined when
 * the artifact id is not in the trace.
 */
export function traceArtifact(trace: RunTrace, artifactId: string): ArtifactTrace | undefined {
  let artifact: Artifact | undefined;
  let task: TracedTask | undefined;
  for (const t of trace.tasks) {
    const found = t.artifacts.find((a) => a.id === artifactId);
    if (found) {
      artifact = found;
      task = t;
      break;
    }
  }
  if (!artifact) return undefined;

  const ancestors = task ? collectAncestors(trace.tasks, task.id) : [];
  const descendants = task ? collectDescendants(trace.tasks, task.id) : [];
  return { artifact, task, ancestors, descendants };
}

function collectAncestors(tasks: TracedTask[], taskId: string): TracedTask[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const acc = new Set<string>();
  const visit = (id: string): void => {
    for (const dep of byId.get(id)?.depends_on ?? []) {
      if (!acc.has(dep)) {
        acc.add(dep);
        visit(dep);
      }
    }
  };
  visit(taskId);
  return tasks.filter((t) => acc.has(t.id));
}

function collectDescendants(tasks: TracedTask[], taskId: string): TracedTask[] {
  const acc = new Set<string>();
  const visit = (id: string): void => {
    for (const t of tasks) {
      if (t.depends_on.includes(id) && !acc.has(t.id)) {
        acc.add(t.id);
        visit(t.id);
      }
    }
  };
  visit(taskId);
  return tasks.filter((t) => acc.has(t.id));
}

type RawTask = { id: string; owner: string; depends_on: string[] };

function extractTasks(response: unknown): RawTask[] {
  if (!response || typeof response !== 'object') return [];
  const raw = (response as { tasks?: unknown }).tasks;
  if (!Array.isArray(raw)) return [];
  const out: RawTask[] = [];
  for (const r of raw) {
    if (
      r &&
      typeof r === 'object' &&
      typeof (r as RawTask).id === 'string' &&
      typeof (r as RawTask).owner === 'string'
    ) {
      const dep = (r as { depends_on?: unknown }).depends_on;
      out.push({
        id: (r as RawTask).id,
        owner: (r as RawTask).owner,
        depends_on: Array.isArray(dep) ? dep.filter((d): d is string => typeof d === 'string') : [],
      });
    }
  }
  return out;
}
