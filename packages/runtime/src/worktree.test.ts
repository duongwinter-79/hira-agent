import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isGitRepo,
  createRunWorktree,
  finalizeWorktree,
  loadWorktreeSetupCommand,
} from './worktree.js';

function sh(cmd: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, { cwd, shell: true, stdio: 'ignore' });
    c.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} → ${code}`))));
    c.on('error', reject);
  });
}

/** Create a throwaway git repo with one commit. */
async function gitRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'hira-wt-'));
  await sh('git init -q', root);
  await sh('git config user.email t@t', root);
  await sh('git config user.name t', root);
  await sh('git config commit.gpgsign false', root);
  await writeFile(join(root, 'file.txt'), 'hello\n');
  await sh('git add -A', root);
  await sh('git commit -q -m init', root);
  return root;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe('isGitRepo', () => {
  it('is true inside a git repo, false outside', async () => {
    const repo = await gitRepo();
    const plain = await mkdtemp(join(tmpdir(), 'hira-plain-'));
    expect(await isGitRepo(repo)).toBe(true);
    expect(await isGitRepo(plain)).toBe(false);
  });
});

describe('createRunWorktree + finalizeWorktree', () => {
  it('creates a worktree on a hira/run-* branch', async () => {
    const repo = await gitRepo();
    await mkdir(join(repo, '.hira', 'runs', 'run-abcdef12'), { recursive: true });

    const wt = await createRunWorktree(repo, 'abcdef12-0000-0000-0000-000000000000');
    expect(wt.branch).toBe('hira/run-abcdef12');
    expect(await exists(wt.path)).toBe(true);
    expect(await exists(join(wt.path, 'file.txt'))).toBe(true);
  });

  it('commits the worktree changes to its branch and removes the worktree dir', async () => {
    const repo = await gitRepo();
    await mkdir(join(repo, '.hira', 'runs', 'run-cafe1234'), { recursive: true });

    const wt = await createRunWorktree(repo, 'cafe1234-0000-0000-0000-000000000000');
    await writeFile(join(wt.path, 'new.txt'), 'developer wrote this\n');
    await writeFile(join(wt.path, 'file.txt'), 'modified\n');

    const outcome = await finalizeWorktree(repo, wt);
    expect(outcome.committed).toBe(true);
    expect(outcome.changedFiles).toBe(2);
    // Worktree directory is gone; the branch survives with the commit.
    expect(await exists(wt.path)).toBe(false);
  });

  it('reports no commit when the Developer made no changes', async () => {
    const repo = await gitRepo();
    await mkdir(join(repo, '.hira', 'runs', 'run-00000000'), { recursive: true });
    const wt = await createRunWorktree(repo, '00000000-0000-0000-0000-000000000000');

    const outcome = await finalizeWorktree(repo, wt);
    expect(outcome.committed).toBe(false);
    expect(outcome.changedFiles).toBe(0);
  });
});

describe('loadWorktreeSetupCommand', () => {
  it('returns the setup command from hira.config.json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hira-cfg-'));
    await writeFile(
      join(root, 'hira.config.json'),
      JSON.stringify({ worktree: { setup: 'pnpm install' } }),
    );
    expect(await loadWorktreeSetupCommand(root)).toBe('pnpm install');
  });

  it('returns null when there is no worktree block', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hira-cfg-'));
    await writeFile(join(root, 'hira.config.json'), JSON.stringify({ verification: {} }));
    expect(await loadWorktreeSetupCommand(root)).toBeNull();
  });

  it('returns null when the file is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hira-cfg-'));
    expect(await loadWorktreeSetupCommand(root)).toBeNull();
  });
});
