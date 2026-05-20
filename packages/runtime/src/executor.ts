import { randomUUID } from 'node:crypto';
import type { Handoff, Journal, VerificationReport } from '@hira/journal';
import type { MemoryRecord } from '@hira/memory';
import { type Bus, type DispatchResult } from './bus.js';
import { verifyDeveloperHandoff, type VerificationConfig } from './verification.js';
import {
  checkConsistency,
  type BaselineAdr,
  type ConsistencyAdr,
  type ConsistencyReport,
} from './consistency.js';

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
  /** UUID of the bus hand-off that ran this task (last attempt for retried tasks). */
  handoff_id?: string;
  status: 'completed' | 'failed' | 'skipped';
  /** Reason when status === 'skipped'. */
  skip_reason?: string;
  /** Parsed fenced JSON from the owner's reply, if any. */
  response?: unknown;
  /** Raw assistant text. */
  response_text?: string;
  /** Number of times the task was dispatched (>1 means the Developer retried). */
  attempts?: number;
  /** Verification report from the deterministic engine, after a Developer task. */
  verification?: VerificationReport;
};

/** Owners that operate inside the Run's git worktree (when one exists). */
const WORKTREE_OWNERS = new Set(['developer', 'tester', 'reviewer']);

/** Total Developer dispatches per task: one initial attempt + one retry. */
const MAX_DEVELOPER_ATTEMPTS = 2;

export type ExecutorConfig = {
  bus: Bus;
  journal: Journal;
  /** Agent names that have real system prompts in this milestone. */
  wiredOwners: Set<string>;
  /** Project root — where read-only specialists run and config is loaded. */
  projectRoot: string;
  /**
   * Tool allowlist override applied to read-only specialists (Knowledge,
   * Architect, Tester, Reviewer). Replaces the manifest list.
   */
  toolsOverride?: string[];
  /**
   * The Run's git worktree (SPEC §4.8). When present, the Developer edits
   * here with real tools, and the Tester / Reviewer read here; the
   * Verification Engine verifies the actual diff. Absent → the Developer
   * stays read-only (M1.5.a behaviour, e.g. non-git projects).
   */
  worktree?: { path: string };
  /**
   * Tool allowlist for the Developer when a worktree exists. Undefined →
   * the Bus uses the Developer's manifest tools (Read/Edit/Write/Bash).
   */
  developerTools?: string[];
  /**
   * Memory records (SPEC §5.8) the runtime fetched for this Run.
   * Injected into every task's payload as `memory_context[]`.
   */
  memoryContext?: MemoryRecord[];
  /**
   * Deterministic Verification Engine config (SPEC §4.8). The engine runs
   * the configured checks after each Developer hand-off. Null → `skipped`.
   */
  verificationConfig?: VerificationConfig | null;
  /**
   * Every known agent name. When provided, the Cross-Artifact Consistency
   * gate (SPEC §4.8) runs before the first Developer task. Undefined → the
   * gate is skipped.
   */
  knownOwners?: Set<string>;
  /** Baseline `adr`-kind memory records, for the consistency gate's duplication check. */
  baselineAdrs?: BaselineAdr[];
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
  /**
   * Set when the deterministic Verification Engine failed a Developer
   * hand-off (after retries). Downstream tasks were skipped.
   */
  gate_failed?: boolean;
  /**
   * Set when the Cross-Artifact Consistency gate blocked dispatch before
   * the Developer task (SPEC §4.8). The Developer and downstream tasks
   * were skipped.
   */
  consistency_blocked?: boolean;
  /** The consistency gate's report, when the gate ran. */
  consistency?: ConsistencyReport;
};

/**
 * Walks the planner's task graph in dependency order and dispatches each
 * task to its owner via the bus.
 *
 * Developer tasks are special: they run inside the Run's git worktree with
 * real tools, the deterministic Verification Engine checks the resulting
 * diff, and a failing report routes the task back to the Developer once
 * (SPEC §4.8). If the gate is still failing after the retry, downstream
 * tasks are skipped.
 *
 * Sequential execution. Parallel fan-out at the same depth is a
 * quota-shaped optimisation deferred per SPEC §12.
 */
export class Executor {
  constructor(private readonly cfg: ExecutorConfig) {}

  async run(input: ExecutorInput): Promise<ExecutorOutput> {
    const order = topoSort(input.tasks);
    if ('error' in order) {
      return { executions: [], graph_error: order.error };
    }

    const executions: TaskExecution[] = [];
    /** When set, every remaining task is skipped with this reason. */
    let halt: string | undefined;
    let verificationGateFailed = false;
    let consistencyBlocked = false;
    let consistencyChecked = false;
    let consistencyReport: ConsistencyReport | undefined;

    for (const task of order.order) {
      const exec: TaskExecution = { task, status: 'skipped' };

      if (halt) {
        exec.skip_reason = halt;
        executions.push(exec);
        continue;
      }
      if (!this.cfg.wiredOwners.has(task.owner)) {
        exec.skip_reason = `owner '${task.owner}' is not wired in this milestone`;
        executions.push(exec);
        continue;
      }

      // Cross-Artifact Consistency gate (SPEC §4.8): runs once, before the
      // first Developer task, over the task graph + the Architect's ADR +
      // baseline memory. A `blocked` report halts dispatch.
      if (task.owner === 'developer' && !consistencyChecked && this.cfg.knownOwners) {
        consistencyChecked = true;
        consistencyReport = await this.runConsistencyGate(input, executions);
        if (consistencyReport.status === 'blocked') {
          halt = 'Cross-Artifact Consistency gate blocked dispatch';
          consistencyBlocked = true;
          exec.skip_reason = halt;
          executions.push(exec);
          continue;
        }
      }

      const deps = task.depends_on
        .map((depId) => executions.find((e) => e.task.id === depId))
        .filter((e): e is TaskExecution => e !== undefined && e.status === 'completed');

      if (task.owner === 'developer') {
        await this.runDeveloperTask(input, task, deps, exec);
        executions.push(exec);
        if (exec.verification?.status === 'fail') {
          verificationGateFailed = true;
          halt = 'upstream Verification Engine gate failed';
        }
      } else {
        const { handoffId, result } = await this.dispatchTask(input, task, deps);
        exec.handoff_id = handoffId;
        exec.response = result.response;
        exec.response_text = result.responseText;
        exec.status = result.exitCode === 0 ? 'completed' : 'failed';
        executions.push(exec);
      }
    }

    return {
      executions,
      ...(verificationGateFailed ? { gate_failed: true } : {}),
      ...(consistencyBlocked ? { consistency_blocked: true } : {}),
      ...(consistencyReport ? { consistency: consistencyReport } : {}),
    };
  }

  /**
   * Run the Cross-Artifact Consistency check and journal it as a
   * `consistency` artifact. Uses the Architect's ADR if one has completed.
   */
  private async runConsistencyGate(
    input: ExecutorInput,
    executions: TaskExecution[],
  ): Promise<ConsistencyReport> {
    const adrExec = executions.find(
      (e) => e.task.owner === 'solution-architect' && e.status === 'completed',
    );
    const report = checkConsistency({
      tasks: input.tasks.map((t) => ({
        id: t.id,
        description: t.description,
        owner: t.owner,
        depends_on: t.depends_on,
      })),
      adr: extractAdr(adrExec?.response),
      baselineAdrs: this.cfg.baselineAdrs ?? [],
      knownOwners: this.cfg.knownOwners ?? new Set(),
    });
    await this.cfg.journal.recordArtifact(
      input.runId,
      'consistency',
      report,
      input.parentHandoffId,
    );
    return report;
  }

  /**
   * Dispatch the Developer, verify with the engine, and retry once if the
   * verification fails. Mutates `exec` with the final outcome.
   */
  private async runDeveloperTask(
    input: ExecutorInput,
    task: PlannerTask,
    deps: TaskExecution[],
    exec: TaskExecution,
  ): Promise<void> {
    let attempt = 0;
    let report: VerificationReport | undefined;
    let lastResult: DispatchResult | undefined;
    let lastHandoffId = '';

    while (attempt < MAX_DEVELOPER_ATTEMPTS) {
      attempt++;
      const extra =
        attempt > 1 && report ? { verification_failure: { attempt, report } } : undefined;
      const { handoffId, result } = await this.dispatchTask(input, task, deps, extra);
      lastResult = result;
      lastHandoffId = handoffId;

      if (result.exitCode !== 0) break; // the dispatch itself failed — don't retry

      report = await verifyDeveloperHandoff(exec, {
        journal: this.cfg.journal,
        runId: input.runId,
        parentHandoffId: handoffId,
        projectRoot: this.cfg.worktree?.path ?? this.cfg.projectRoot,
        config: this.cfg.verificationConfig ?? null,
      });
      if (report.status !== 'fail') break; // pass or skipped → done
    }

    exec.handoff_id = lastHandoffId;
    exec.attempts = attempt;
    exec.response = lastResult?.response;
    exec.response_text = lastResult?.responseText;
    exec.status = lastResult && lastResult.exitCode === 0 ? 'completed' : 'failed';
    exec.verification = report;
  }

  /** Build the task envelope and dispatch it through the bus. */
  private async dispatchTask(
    input: ExecutorInput,
    task: PlannerTask,
    deps: TaskExecution[],
    extraPayload?: Record<string, unknown>,
  ): Promise<{ handoffId: string; result: DispatchResult }> {
    const handoffId = randomUUID();
    const envelope: Handoff = {
      run_id: input.runId,
      handoff_id: handoffId,
      parent_handoff_id: input.parentHandoffId,
      task_id: task.id,
      from: 'orchestrator',
      to: task.owner,
      kind: 'request',
      payload: {
        task: { id: task.id, description: task.description },
        dependencies: deps.map((d) => ({
          task_id: d.task.id,
          owner: d.task.owner,
          response: d.response,
          verification: d.verification ?? null,
        })),
        memory_context: this.cfg.memoryContext ?? [],
        ...extraPayload,
      },
      artifacts: [],
      delta_refs: [],
    };
    const result = await this.cfg.bus.dispatch(envelope, {
      tools: this.taskTools(task.owner),
      cwd: this.taskCwd(task.owner),
    });
    return { handoffId, result };
  }

  /** Working directory for a task's agent. */
  private taskCwd(owner: string): string {
    if (this.cfg.worktree && WORKTREE_OWNERS.has(owner)) {
      return this.cfg.worktree.path;
    }
    return this.cfg.projectRoot;
  }

  /**
   * Tool allowlist for a task's agent. The Developer gets real tools
   * (its manifest, or `developerTools`) when a worktree exists; everyone
   * else gets the read-only override.
   */
  private taskTools(owner: string): string[] | undefined {
    if (owner === 'developer' && this.cfg.worktree) {
      return this.cfg.developerTools;
    }
    return this.cfg.toolsOverride;
  }
}

/** Project the Architect's ADR response into the consistency check's shape. */
function extractAdr(response: unknown): ConsistencyAdr | null {
  if (!response || typeof response !== 'object') return null;
  const title = (response as { title?: unknown }).title;
  return typeof title === 'string' ? { title } : null;
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
