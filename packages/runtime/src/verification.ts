import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Journal, VerificationReport } from '@hira/journal';
import type { TaskExecution } from './executor.js';

/**
 * Deterministic Verification Engine (SPEC §4.8).
 *
 * Runtime-owned, *not* an agent. After a Developer hand-off it runs the
 * project's own checks — test suite, type checker, linter — and produces a
 * structured report that gates the route to the model Reviewer.
 *
 * The engine is a thin harness: it shells out to commands the project
 * declares in `hira.config.json`. It does not know how to test or lint
 * anything itself; tool selection is per-project config (SPEC §12 #14).
 */

export type VerificationCheck = {
  /** Short stage label, e.g. "test", "typecheck", "lint". */
  name: string;
  /** Shell command run from the project root. */
  command: string;
  /** Per-check timeout; defaults to 5 minutes. */
  timeout_ms?: number;
};

export type VerificationConfig = {
  checks: VerificationCheck[];
};

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_CHARS = 4000;

/**
 * Load the `verification` block from `<projectRoot>/hira.config.json`.
 * Returns null when the file is absent, malformed, or declares no checks —
 * the engine then reports `skipped` rather than inventing commands.
 */
export async function loadVerificationConfig(
  projectRoot: string,
): Promise<VerificationConfig | null> {
  const path = join(projectRoot, 'hira.config.json');
  const raw = await readFile(path, 'utf8').catch(() => null);
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const block = (parsed as { verification?: unknown }).verification;
  if (!block || typeof block !== 'object') return null;
  const checks = (block as { checks?: unknown }).checks;
  if (!Array.isArray(checks)) return null;

  const valid: VerificationCheck[] = [];
  for (const c of checks) {
    if (
      c &&
      typeof c === 'object' &&
      typeof (c as VerificationCheck).name === 'string' &&
      typeof (c as VerificationCheck).command === 'string'
    ) {
      const check = c as VerificationCheck;
      valid.push({
        name: check.name,
        command: check.command,
        ...(typeof check.timeout_ms === 'number' ? { timeout_ms: check.timeout_ms } : {}),
      });
    }
  }
  return valid.length > 0 ? { checks: valid } : null;
}

type CheckResult = { status: 'pass' | 'fail'; output: string };

/**
 * Run one check command from `cwd`. The command comes from the project's
 * own `hira.config.json`, so it's as trusted as a `package.json` script;
 * `shell: true` is intentional.
 */
function runCheck(check: VerificationCheck, cwd: string): Promise<CheckResult> {
  return new Promise((resolveCheck) => {
    const child = spawn(check.command, {
      cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    const capture = (buf: Buffer): void => {
      output += buf.toString('utf8');
      // Keep the tail — failures and stack traces land at the end.
      if (output.length > MAX_OUTPUT_CHARS * 2) {
        output = output.slice(-MAX_OUTPUT_CHARS * 2);
      }
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);

    const timer = setTimeout(() => child.kill('SIGKILL'), check.timeout_ms ?? DEFAULT_TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolveCheck({
        status: code === 0 ? 'pass' : 'fail',
        output: output.trim().slice(-MAX_OUTPUT_CHARS),
      });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolveCheck({ status: 'fail', output: `failed to spawn: ${String(err)}` });
    });
  });
}

export type VerificationEngineOptions = {
  projectRoot: string;
  config: VerificationConfig | null;
};

/**
 * Run every configured check in sequence and fold the results into a
 * single VerificationReport. Status is `fail` if any stage failed,
 * `skipped` if there is no config, otherwise `pass`.
 */
export async function runVerificationEngine(
  opts: VerificationEngineOptions,
): Promise<VerificationReport> {
  if (!opts.config) {
    return {
      status: 'skipped',
      stages: [
        {
          name: 'config',
          status: 'skipped',
          output:
            'No hira.config.json verification block. Add one to enable deterministic checks.',
        },
      ],
    };
  }

  const stages: VerificationReport['stages'] = [];
  let anyFail = false;
  for (const check of opts.config.checks) {
    const result = await runCheck(check, opts.projectRoot);
    if (result.status === 'fail') anyFail = true;
    stages.push({ name: check.name, status: result.status, output: result.output });
  }

  return { status: anyFail ? 'fail' : 'pass', stages };
}

/**
 * Verification seam called by the Executor after a successful Developer
 * hand-off. Runs the engine, journals the report as a `verification`
 * artifact attached to the Developer hand-off (so SPEC §4.9 traceability
 * walks through it), and returns it for the Reviewer's input.
 *
 * M1.5.a: the Developer is still dry-mode, so the engine verifies the
 * project's *baseline* health. M1.5.b applies the Developer's change in a
 * worktree first, making this a verification of the actual diff.
 */
export async function verifyDeveloperHandoff(
  _developerExec: TaskExecution,
  options: {
    journal: Journal;
    runId: string;
    /** The Developer hand-off id — verification attaches to it. */
    parentHandoffId: string;
    projectRoot: string;
    config: VerificationConfig | null;
  },
): Promise<VerificationReport> {
  const report = await runVerificationEngine({
    projectRoot: options.projectRoot,
    config: options.config,
  });
  await options.journal.recordArtifact(
    options.runId,
    'verification',
    report,
    options.parentHandoffId,
  );
  return report;
}
