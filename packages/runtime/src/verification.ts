import type { Journal, VerificationReport } from '@hira/journal';
import type { TaskExecution } from './executor.js';

/**
 * Deterministic Verification Engine seam (SPEC §4.8).
 *
 * Runs after every successful Developer hand-off to gate the route to the
 * Reviewer. M1.3 ships the seam only — every stage returns `skipped`. The
 * real engine (test runner + type checker + lint, optional Semgrep /
 * Schemathesis per project config) lands in M1.5; this function's shape
 * stays the same so call-sites don't move.
 *
 * The seam is journaled as a `verification` artifact attached to the
 * Developer hand-off, so SPEC §4.9 traceability already walks through it
 * once it goes live.
 */
export async function verifyDeveloperHandoff(
  _developerExec: TaskExecution,
  options: {
    journal: Journal;
    runId: string;
    /** The Developer hand-off id — verification attaches to it. */
    parentHandoffId: string;
  },
): Promise<VerificationReport> {
  const report: VerificationReport = {
    status: 'skipped',
    stages: [
      {
        name: 'tests',
        status: 'skipped',
        output: 'Verification Engine not yet implemented (M1.5).',
      },
      { name: 'typecheck', status: 'skipped' },
      { name: 'lint', status: 'skipped' },
    ],
  };
  await options.journal.recordArtifact(
    options.runId,
    'verification',
    report,
    options.parentHandoffId,
  );
  return report;
}
