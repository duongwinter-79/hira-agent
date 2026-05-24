import { mkdir, readFile, readdir, stat, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  Handoff,
  HandoffRecord,
  HandoffStatus,
  RunApproval,
  RunRecord,
  RunStatus,
  Artifact,
} from './types.js';

type JournalEvent =
  | ({ t: 'run_started' } & RunRecord)
  | ({ t: 'handoff_started'; run_id: string } & HandoffRecord)
  | {
      t: 'handoff_completed';
      run_id: string;
      handoff_id: string;
      status: HandoffStatus;
      ended_at: string;
      session_id?: string;
      response?: unknown;
      response_text?: string;
      exit_code?: number;
      stderr_excerpt?: string;
      schema_error?: string;
    }
  | ({ t: 'artifact_recorded'; run_id: string } & Artifact)
  | { t: 'run_closed'; run_id: string; ended_at: string; status: RunStatus }
  | { t: 'run_approval'; run_id: string; decision: RunApproval; at: string }
  | {
      t: 'handoff_progress';
      run_id: string;
      handoff_id: string;
      at: string;
      phase: string;
      detail?: string;
    };

/**
 * Append-only JSONL journal at `.hira/runs/<run_id>/journal.jsonl`.
 *
 * One Journal instance scopes to one project root. Each Run gets its own
 * directory + jsonl file. Reads scan/replay events to reconstruct state.
 *
 * JSONL is good enough for M1.1 (single-writer, small per-run files). When
 * §4.9 `hira runs trace` queries need cross-run indexes (M1.5+), swap the
 * backend to SQLite without changing the public API.
 */
export class Journal {
  private readonly runsRoot: string;
  /** Per-run, per-artifact-kind monotonic sequence counters. */
  private readonly seqCounters = new Map<string, number>();
  /**
   * Serialises all appends so concurrent writes — e.g. fire-and-forget
   * live progress events racing the awaited `completeHandoff` — cannot
   * interleave bytes in the JSONL file.
   */
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(projectRoot: string) {
    this.runsRoot = join(projectRoot, '.hira', 'runs');
  }

  async openRun(intent: string): Promise<RunRecord> {
    const id = randomUUID();
    const dir = join(this.runsRoot, id);
    await mkdir(dir, { recursive: true });
    const run: RunRecord = {
      id,
      intent_message: intent,
      started_at: new Date().toISOString(),
      status: 'running',
    };
    await this.append(id, { t: 'run_started', ...run });
    return run;
  }

  async recordHandoffStart(handoff: Handoff): Promise<HandoffRecord> {
    const record: HandoffRecord = {
      ...handoff,
      status: 'in_progress',
      started_at: new Date().toISOString(),
    };
    await this.append(handoff.run_id, { t: 'handoff_started', ...record });
    return record;
  }

  async completeHandoff(
    runId: string,
    handoffId: string,
    update: {
      status: HandoffStatus;
      session_id?: string;
      response?: unknown;
      response_text?: string;
      exit_code?: number;
      stderr_excerpt?: string;
      schema_error?: string;
    },
  ): Promise<void> {
    await this.append(runId, {
      t: 'handoff_completed',
      run_id: runId,
      handoff_id: handoffId,
      ended_at: new Date().toISOString(),
      ...update,
    });
  }

  async recordArtifact(
    runId: string,
    kind: string,
    payload: unknown,
    handoffId?: string,
  ): Promise<Artifact> {
    const key = `${runId}::${kind}`;
    const seq = (this.seqCounters.get(key) ?? 0) + 1;
    this.seqCounters.set(key, seq);
    const artifact: Artifact = {
      id: `${kind}:${runId.slice(0, 8)}:${seq}`,
      kind,
      payload,
      created_at: new Date().toISOString(),
      handoff_id: handoffId,
    };
    await this.append(runId, { t: 'artifact_recorded', run_id: runId, ...artifact });
    return artifact;
  }

  async closeRun(runId: string, status: Exclude<RunStatus, 'running'>): Promise<void> {
    await this.append(runId, {
      t: 'run_closed',
      run_id: runId,
      ended_at: new Date().toISOString(),
      status,
    });
  }

  /** Record the user's approve/reject decision for a Run (SPEC §4.8). */
  async recordApproval(runId: string, decision: RunApproval): Promise<void> {
    await this.append(runId, {
      t: 'run_approval',
      run_id: runId,
      decision,
      at: new Date().toISOString(),
    });
  }

  /**
   * Append a live progress entry for an in-flight hand-off. Called as the
   * agent's session streams events, so a hand-off that never completes
   * (a crash) still shows how far it got.
   */
  async recordHandoffProgress(
    runId: string,
    handoffId: string,
    phase: string,
    detail?: string,
  ): Promise<void> {
    await this.append(runId, {
      t: 'handoff_progress',
      run_id: runId,
      handoff_id: handoffId,
      at: new Date().toISOString(),
      phase,
      ...(detail !== undefined ? { detail } : {}),
    });
  }

  async listRuns(limit = 50): Promise<RunRecord[]> {
    const entries = await safeReaddir(this.runsRoot);
    const runs: RunRecord[] = [];
    for (const entry of entries) {
      const runDir = join(this.runsRoot, entry);
      if (!(await isDir(runDir))) continue;
      const events = await this.readEvents(entry).catch(() => []);
      const run = projectRun(events);
      if (run) runs.push(run);
    }
    runs.sort((a, b) => b.started_at.localeCompare(a.started_at));
    return runs.slice(0, limit);
  }

  async getRun(
    runId: string,
  ): Promise<{ run: RunRecord; handoffs: HandoffRecord[]; artifacts: Artifact[] } | undefined> {
    const events = await this.readEvents(runId).catch(() => null);
    if (!events) return undefined;
    const run = projectRun(events);
    if (!run) return undefined;
    const { handoffs, artifacts } = projectHandoffsAndArtifacts(events);
    return { run, handoffs, artifacts };
  }

  /**
   * Path to the run directory; callers (e.g. the CLI) drop per-agent
   * isolation settings here too.
   */
  runDir(runId: string): string {
    return join(this.runsRoot, runId);
  }

  private append(runId: string, event: JournalEvent): Promise<void> {
    const path = join(this.runsRoot, runId, 'journal.jsonl');
    const line = JSON.stringify(event) + '\n';
    const result = this.writeQueue.then(() => appendFile(path, line, 'utf8'));
    // Keep the queue alive even if one write rejects; the caller still
    // sees the real error via the returned promise.
    this.writeQueue = result.catch(() => undefined);
    return result;
  }

  private async readEvents(runId: string): Promise<JournalEvent[]> {
    const path = join(this.runsRoot, runId, 'journal.jsonl');
    const raw = await readFile(path, 'utf8');
    const out: JournalEvent[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      out.push(JSON.parse(trimmed) as JournalEvent);
    }
    return out;
  }
}

function projectRun(events: JournalEvent[]): RunRecord | undefined {
  let run: RunRecord | undefined;
  for (const e of events) {
    if (e.t === 'run_started') {
      run = {
        id: e.id,
        intent_message: e.intent_message,
        started_at: e.started_at,
        status: e.status,
      };
    } else if (e.t === 'run_closed' && run) {
      run = { ...run, ended_at: e.ended_at, status: e.status };
    } else if (e.t === 'run_approval' && run) {
      run = { ...run, approval: e.decision, approved_at: e.at };
    }
  }
  return run;
}

function projectHandoffsAndArtifacts(events: JournalEvent[]): {
  handoffs: HandoffRecord[];
  artifacts: Artifact[];
} {
  const handoffs = new Map<string, HandoffRecord>();
  const artifacts: Artifact[] = [];
  for (const e of events) {
    if (e.t === 'handoff_started') {
      const { t: _t, ...rest } = e;
      handoffs.set(e.handoff_id, rest as HandoffRecord);
    } else if (e.t === 'handoff_completed') {
      const existing = handoffs.get(e.handoff_id);
      if (existing) {
        handoffs.set(e.handoff_id, {
          ...existing,
          status: e.status,
          ended_at: e.ended_at,
          session_id: e.session_id ?? existing.session_id,
          response: e.response ?? existing.response,
          response_text: e.response_text ?? existing.response_text,
          exit_code: e.exit_code ?? existing.exit_code,
          stderr_excerpt: e.stderr_excerpt ?? existing.stderr_excerpt,
          schema_error: e.schema_error ?? existing.schema_error,
        });
      }
    } else if (e.t === 'handoff_progress') {
      const existing = handoffs.get(e.handoff_id);
      if (existing) {
        const progress = [...(existing.progress ?? [])];
        progress.push({
          at: e.at,
          phase: e.phase,
          ...(e.detail !== undefined ? { detail: e.detail } : {}),
        });
        handoffs.set(e.handoff_id, { ...existing, progress });
      }
    } else if (e.t === 'artifact_recorded') {
      const { t: _t, run_id: _r, ...rest } = e;
      artifacts.push(rest as Artifact);
    }
  }
  return { handoffs: [...handoffs.values()], artifacts };
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

