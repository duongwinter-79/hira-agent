import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LoadedSkill } from '@hira/plugin-loader';
import { loadBehaviouralSkills, composeSystemPrompt } from './skills.js';

async function tmpSkill(name: string, content: string): Promise<LoadedSkill> {
  const root = await mkdtemp(join(tmpdir(), 'hira-skill-'));
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), content);
  return {
    dir,
    manifest: { name, version: '1.0.0', kind: 'skill' },
  };
}

describe('loadBehaviouralSkills', () => {
  it('returns [] for an empty allowlist without touching disk', async () => {
    const out = await loadBehaviouralSkills([], []);
    expect(out).toEqual([]);
  });

  it('loads SKILL.md and strips YAML frontmatter', async () => {
    const skill = await tmpSkill(
      'karpathy-guidelines',
      `---\nname: karpathy-guidelines\ndescription: foo\n---\n\n# Karpathy Guidelines\n\nBe surgical.\n`,
    );
    const out = await loadBehaviouralSkills([skill], ['karpathy-guidelines']);
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe('karpathy-guidelines');
    expect(out[0]!.body).toContain('# Karpathy Guidelines');
    expect(out[0]!.body).not.toContain('description: foo');
  });

  it('throws on unknown skill names rather than silently dropping context', async () => {
    await expect(loadBehaviouralSkills([], ['nope'])).rejects.toThrow(/unknown skill 'nope'/);
  });

  it('keeps content untouched when there is no frontmatter', async () => {
    const skill = await tmpSkill('plain', `Just a guideline.\n`);
    const out = await loadBehaviouralSkills([skill], ['plain']);
    expect(out[0]!.body).toBe('Just a guideline.\n');
  });

  it('skips silently when a skill has no SKILL.md (non-behavioural)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hira-skill-'));
    const dir = join(root, 'mcp-tool');
    await mkdir(dir, { recursive: true });
    const skill: LoadedSkill = {
      dir,
      manifest: { name: 'mcp-tool', version: '1.0.0', kind: 'skill' },
    };
    const out = await loadBehaviouralSkills([skill], ['mcp-tool']);
    expect(out).toEqual([]);
  });
});

describe('composeSystemPrompt', () => {
  it('returns the agent prompt unchanged when no behavioural skills apply', () => {
    expect(composeSystemPrompt('You are the developer.', [])).toBe('You are the developer.');
  });

  it('prepends behavioural skills wrapped in tagged blocks, in allowlist order', () => {
    const composed = composeSystemPrompt('You are the developer.', [
      { name: 'first', body: 'Rule A' },
      { name: 'second', body: 'Rule B' },
    ]);
    const firstIdx = composed.indexOf('<behavioural-skill name="first">');
    const secondIdx = composed.indexOf('<behavioural-skill name="second">');
    const agentIdx = composed.indexOf('You are the developer.');
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(secondIdx).toBeGreaterThan(firstIdx);
    expect(agentIdx).toBeGreaterThan(secondIdx);
  });
});
