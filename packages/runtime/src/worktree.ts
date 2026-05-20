import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Per-Run git worktree (SPEC §4.8 delta principle).
 *
 * The Developer edits inside an isolated worktree on a throwaway branch so
 * the user's main checkout is never mutated. The Verification Engine runs
 * there too, verifying the actual diff. On finalize the worktree's changes
 * are committed to the branch and the worktree directory is removed — the
 * branch persists so the user can inspect / merge / discard it.
 */

export type RunWorktree = {
  /** Absolute path to the worktree directory. */
  path: string;
  /** Branch the worktree is checked out on. */
  branch: string;
};

export type WorktreeOutcome = {
  branch: string;
  /** True if the Developer's changes were committed to the branch. */
  committed: boolean;
  /** Number of files changed by the Run. */
  changedFiles: number;
};

type GitResult = { code: number; stdout: string; stderr: string };

function git(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolveGit) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b: Buffer) => (stdout += b.toString('utf8')));
    child.stderr.on('data', (b: Buffer) => (stderr += b.toString('utf8')));
    child.on('close', (code) => resolveGit({ code: code ?? 0, stdout, stderr }));
    child.on('error', (err) => resolveGit({ code: 1, stdout, stderr: String(err) }));
  });
}

/** True if `projectRoot` is inside a git working tree. */
export async function isGitRepo(projectRoot: string): Promise<boolean> {
  const r = await git(['rev-parse', '--is-inside-work-tree'], projectRoot);
  return r.code === 0 && r.stdout.trim() === 'true';
}

/**
 * Create a worktree for a Run, branched from the current HEAD.
 * Throws if `git worktree add` fails (caller should have checked isGitRepo).
 */
export async function createRunWorktree(
  projectRoot: string,
  runId: string,
): Promise<RunWorktree> {
  const branch = `hira/run-${runId.slice(0, 8)}`;
  const path = join(projectRoot, '.hira', 'runs', runId, 'worktree');
  const r = await git(['worktree', 'add', '-b', branch, path, 'HEAD'], projectRoot);
  if (r.code !== 0) {
    throw new Error(`git worktree add failed: ${r.stderr.trim() || r.stdout.trim()}`);
  }
  return { path, branch };
}

/**
 * Run the project's worktree setup command (e.g. `pnpm install`) so the
 * Verification Engine has dependencies available. Failures are reported,
 * not thrown — verification will surface the consequence.
 */
export function runWorktreeSetup(
  worktreePath: string,
  command: string,
  timeoutMs = 5 * 60_000,
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolveSetup) => {
    const child = spawn(command, {
      cwd: worktreePath,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const capture = (b: Buffer): void => {
      output += b.toString('utf8');
      if (output.length > 8000) output = output.slice(-8000);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveSetup({ ok: code === 0, output: output.trim() });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolveSetup({ ok: false, output: String(err) });
    });
  });
}

/**
 * Commit the worktree's changes to its branch and remove the worktree
 * directory. The branch survives so the user can inspect the delta with
 * `git diff <base>..<branch>` and merge or delete it.
 */
export async function finalizeWorktree(
  projectRoot: string,
  wt: RunWorktree,
): Promise<WorktreeOutcome> {
  await git(['add', '-A'], wt.path);
  const status = await git(['status', '--porcelain'], wt.path);
  const lines = status.stdout.trim() ? status.stdout.trim().split('\n') : [];
  const changedFiles = lines.length;

  let committed = false;
  if (changedFiles > 0) {
    const commit = await git(
      [
        '-c',
        'user.email=hira@localhost',
        '-c',
        'user.name=Hira',
        'commit',
        '-m',
        `Hira run ${wt.branch}`,
      ],
      wt.path,
    );
    committed = commit.code === 0;
  }

  await git(['worktree', 'remove', '--force', wt.path], projectRoot);
  return { branch: wt.branch, committed, changedFiles };
}

/**
 * Delete a Run's worktree branch (used by `hira runs reject`). Best-effort —
 * returns false if the branch does not exist or git refuses.
 */
export async function deleteRunBranch(projectRoot: string, branch: string): Promise<boolean> {
  const r = await git(['branch', '-D', branch], projectRoot);
  return r.code === 0;
}

/** Read the optional `worktree.setup` command from hira.config.json. */
export async function loadWorktreeSetupCommand(projectRoot: string): Promise<string | null> {
  const raw = await readFile(join(projectRoot, 'hira.config.json'), 'utf8').catch(() => null);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const wt = (parsed as { worktree?: unknown }).worktree;
  if (!wt || typeof wt !== 'object') return null;
  const setup = (wt as { setup?: unknown }).setup;
  return typeof setup === 'string' && setup.trim() ? setup : null;
}
