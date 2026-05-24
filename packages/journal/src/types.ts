import { z } from 'zod';

/** Hand-off taxonomy from SPEC §6. */
export const HandoffKindSchema = z.enum(['request', 'response', 'escalation', 'review']);
export type HandoffKind = z.infer<typeof HandoffKindSchema>;

/**
 * A handoff artifact carries a structured payload (patch, ADR, test report,
 * citation, …) attached to a hand-off. Artifact IDs are stable across
 * replays so SPEC §4.9 traceability works in either direction.
 *
 * ID scheme: `{kind}:{run_id_short}:{seq}` — grep-friendly, monotonic per
 * (run, kind), survives replay because the journal is the source of truth
 * for `seq`.
 */
export const ArtifactSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  payload: z.unknown(),
  created_at: z.string().optional(),
  /** Hand-off that produced this artifact. */
  handoff_id: z.string().optional(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

/**
 * Forward-compat report from the deterministic Verification Engine (§4.8).
 * Nullable in M1; populated starting M1.5. Defined here so the envelope
 * shape is stable.
 */
export const VerificationReportSchema = z.object({
  status: z.enum(['pass', 'fail', 'skipped']),
  stages: z.array(
    z.object({
      name: z.string(),
      status: z.enum(['pass', 'fail', 'skipped']),
      output: z.string().optional(),
    }),
  ),
});
export type VerificationReport = z.infer<typeof VerificationReportSchema>;

/**
 * The typed envelope from SPEC §6. Extra forward-compat fields per PR #4:
 *   verification_report?  — populated by the engine in M1.5
 *   delta_refs[]          — IDs of spec/ADR deltas this hand-off proposes (§4.8)
 */
export const HandoffSchema = z.object({
  run_id: z.string().min(1),
  handoff_id: z.string().min(1),
  parent_handoff_id: z.string().optional(),
  task_id: z.string().optional(),
  from: z.string().min(1),
  to: z.string().min(1),
  kind: HandoffKindSchema,
  payload: z.unknown(),
  artifacts: z.array(ArtifactSchema).default([]),
  verification_report: VerificationReportSchema.nullable().optional(),
  delta_refs: z.array(z.string()).default([]),
});
export type Handoff = z.infer<typeof HandoffSchema>;

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

/** Post-Run user decision (SPEC §4.8 delta state machine). */
export type RunApproval = 'approved' | 'rejected';

export type RunRecord = {
  id: string;
  intent_message: string;
  started_at: string;
  ended_at?: string;
  status: RunStatus;
  /** Set once the user approves or rejects the Run's deltas. */
  approval?: RunApproval;
  /** ISO timestamp of the approval decision. */
  approved_at?: string;
};

export type HandoffStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/**
 * A live progress entry streamed from a hand-off's agent session while it
 * runs. Lets a crashed, never-completed hand-off still show how far it got.
 */
export type HandoffProgress = {
  at: string;
  /** 'started' | 'message' | 'tool'. */
  phase: string;
  /** Session id, tool name(s), or a short message preview. */
  detail?: string;
};

export type HandoffRecord = Handoff & {
  status: HandoffStatus;
  started_at: string;
  ended_at?: string;
  /** Claude Code session UUID, if captured. */
  session_id?: string;
  /** Parsed structured reply, if the agent produced one. */
  response?: unknown;
  /** Raw assistant text. */
  response_text?: string;
  /** Process exit code. */
  exit_code?: number;
  /** First 2 KB of stderr; full stderr is in the per-agent run dir. */
  stderr_excerpt?: string;
  /**
   * Schema-validation error from the agent's `outputs.schema`, when the
   * fenced JSON reply failed validation. The hand-off completed but its
   * structured `response` was discarded.
   */
  schema_error?: string;
  /** Live progress trail streamed while the hand-off ran. */
  progress?: HandoffProgress[];
};
