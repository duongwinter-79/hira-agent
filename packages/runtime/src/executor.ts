import { randomUUID } from 'node:crypto';
import type { Handoff, Journal } from '@hira/journal';
import type { MemoryRecord } from '@hira/memory';
import { type Bus, type DispatchResult } from './bus.js';
import { type VerificationReport } from '@hira/journal';
import { verifyDeveloperHandoff, type VerificationConfig } from './verification.js';

/** Subset of the planner's task graph the executor walks. */
export type PlannerTask = {
  id: string;
  description: string;
  /** Which agent owns this task — must match a loaded agent name. */
  owner: string;
  depends_on: string[];
};

export type TaskExecution = {
  task: PlannerTask;
  /** UUID of the bus hand-off that ran this task. */
  handoff_id?: string;
  status: 'completed' | 'failed' | 'skipped';
  /** Reason when status === 'skipped'. */
  skip_reason?: string;
  /** Parsed fenced JSON from the owner's reply, if any. */
  response?: unknown;
  /** Raw assistant text. */
  response_text?: string;
  /**
   * Verification report attached after a Developer task. M1.3 leaves this
   * as { status: 'skipped' } — the deterministic Verification Engine
   * lands in M1.5 (SPEC §4.8).
   */
  verification?: VerificationReport;
};

export type ExecutorConfig = {
  bus: Bus;
  journal: Journal;
  /** Agent names that have real system prompts in this milestone. */
  wiredOwners: Set<string>;
  /** Project root — where the Verification Engine runs its checks. */
  projectRoot: string;
  /**
   * Optional tool allowlist override applied to every specialist
   * dispatch — used in M1.3 to keep Developer/Tester read-only until
   * the Verification Engine lands.
   */
  toolsOverride?: string[];
  /**
   * Memory records (SPEC §5.8) the runtime fetched for this Run.
   * Injected into every task's payload as `memory_context[]` so
   * specialists — especially Knowledge — can build on prior facts and
   * cite them by `memory:<id>`.
   */
  memoryContext?: MemoryRecord[];
  /**
   * Deterministic Verification Engine config (SPEC §4.8). When present,
   * the engine runs the configured checks after each Developer hand-off.
   * Null/undefined → the engine reports `skipped`.
   */
  verificationConfig?: VerificationConfig | null;
};

export type ExecutorInput = {
  runId: string;
  /** Hand-off id of the planner invocation; becomes parent_handoff_id of the first task. */
  parentHandoffId: string;
  tasks: PlannerTask[];
};

export type ExecutorOutput = {
  executions: TaskExecution[];
  /** Set when the graph is malformed (cycle or unknown dependency). */
  graph_error?: string;
};

/**
 * Walks the planner's task graph in dependency order and dispatches each
 * task to its owner via the bus. M1.3.a wires Knowledge and Solution
 * Architect; other owners are journaled as `skipped` with a clear reason
 * until M1.3.b/M1.5.
 *
 * Sequential execution for now. Parallel fan-out (independent tasks at
 * the same depth) is a quota-shaped optimisation deferred to a later
 * milestone (SPEC §12 open question on concurrency vs quota).
 */
export class Executor {
  constructor(private readonly cfg: ExecutorConfig) {}

  async run(input: ExecutorInput): Promise<ExecutorOutput> {
    const order = topoSort(input.tasks);
    if ('error' in order) {
      return { executions: [], graph_error: order.error };
    }

    const executions: TaskExecution[] = [];
    let lastDeveloperExec: TaskExecution | undefined;

    for (const task of order.order) {
      const exec: TaskExecution = { task, status: 'skipped' };

      if (!this.cfg.wiredOwners.has(task.owner)) {
        exec.skip_reason = `owner '${task.owner}' is not wired in this milestone`;
        executions.push(exec);
        continue;
      }

      const dependencySummaries = task.depends_on
        .map((depId) => executions.find((e) => e.task.id === depId))
        .filter((e): e is TaskExecution => e !== undefined && e.status === 'completed');

      const envelope: Handoff = {
        run_id: input.runId,
        handoff_id: randomUUID(),
        parent_handoff_id: input.parentHandoffId,
        task_id: task.id,
        from: 'orchestrator',
        to: task.owner,
        kind: 'request',
        payload: {
          task: {
            id: task.id,
            description: task.description,
          },
          dependencies: dependencySummaries.map((d) => ({
            task_id: d.task.id,
            owner: d.task.owner,
            response: d.response,
            verification: d.verification ?? null,
          })),
          memory_context: this.cfg.memoryContext ?? [],
        },
        artifacts: [],
        delta_refs: [],
      };

      const result: DispatchResult = await this.cfg.bus.dispatch(envelope, {
        tools: this.cfg.toolsOverride,
      });

      exec.handoff_id = envelope.handoff_id;
      exec.response = result.response;
      exec.response_text = result.responseText;
      exec.status = result.exitCode === 0 ? 'completed' : 'failed';
      executions.push(exec);

      // Verification seam (SPEC §4.8): after a successful Developer task,
      // run the deterministic Verification Engine. M1.5.a runs the
      // project's configured checks; the report is journaled and flows
      // into the Reviewer's input.
      if (task.owner === 'developer' && exec.status === 'completed') {
        exec.verification = await verifyDeveloperHandoff(exec, {
          journal: this.cfg.journal,
          runId: input.runId,
          parentHandoffId: envelope.handoff_id,
          projectRoot: this.cfg.projectRoot,
          config: this.cfg.verificationConfig ?? null,
        });
        lastDeveloperExec = exec;
      }

      // The Reviewer needs the Verification report attached to its input.
      // Even though we don't surface a separate "review-of-developer" path
      // in M1.3.a (no Developer wired yet), this is where it will be wired
      // in M1.3.b; recorded here to keep the seam visible.
      void lastDeveloperExec;
    }

    return { executions };
  }
}

type TopoResult = { order: PlannerTask[] } | { error: string };

function topoSort(tasks: PlannerTask[]): TopoResult {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const t of tasks) {
    for (const dep of t.depends_on) {
      if (!byId.has(dep)) {
        return { error: `task '${t.id}' depends on unknown task '${dep}'` };
      }
    }
  }

  const indeg = new Map<string, number>();
  for (const t of tasks) indeg.set(t.id, t.depends_on.length);

  const ready: PlannerTask[] = [];
  for (const t of tasks) if ((indeg.get(t.id) ?? 0) === 0) ready.push(t);

  const order: PlannerTask[] = [];
  while (ready.length > 0) {
    const next = ready.shift()!;
    order.push(next);
    for (const t of tasks) {
      if (t.depends_on.includes(next.id)) {
        const newDeg = (indeg.get(t.id) ?? 0) - 1;
        indeg.set(t.id, newDeg);
        if (newDeg === 0) ready.push(t);
      }
    }
  }

  if (order.length !== tasks.length) {
    return { error: 'task graph contains a cycle' };
  }
  return { order };
}
