import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LoadedSkill } from '@hira/plugin-loader';

/**
 * Render a behavioural skill (Claude Code-style: SKILL.md with YAML
 * frontmatter) into a string the session driver can append to the agent's
 * system prompt.
 *
 * Per M1 decision, behavioural skills are inlined into the system prompt at
 * spawn time rather than mounted via `--plugin-dir`. This makes loading
 * deterministic, testable, and independent of Claude Code's slash-command
 * resolution. Add a `type:` discriminator to skill.yaml later when we mix
 * behavioural with MCP/process skills.
 */

export type RenderedBehaviouralSkill = {
  name: string;
  body: string;
};

/**
 * For each skill name in `allowlist`, locate the loaded skill, read its
 * `SKILL.md`, strip the YAML frontmatter, and return the body. Unknown
 * names throw — fail loud rather than silently drop behavioural context.
 */
export async function loadBehaviouralSkills(
  loaded: LoadedSkill[],
  allowlist: string[],
): Promise<RenderedBehaviouralSkill[]> {
  if (allowlist.length === 0) return [];
  const byName = new Map(loaded.map((s) => [s.manifest.name, s]));
  const out: RenderedBehaviouralSkill[] = [];
  for (const name of allowlist) {
    const skill = byName.get(name);
    if (!skill) {
      throw new Error(
        `Agent allowlist references unknown skill '${name}'. Known: ${[...byName.keys()].join(', ') || '(none)'}`,
      );
    }
    const path = join(skill.dir, 'SKILL.md');
    const raw = await readFile(path, 'utf8').catch(() => null);
    if (raw === null) {
      // No SKILL.md — skill is not behavioural; skip it. Future MCP/process
      // skills will be handled by separate resolvers.
      continue;
    }
    out.push({ name, body: stripFrontmatter(raw) });
  }
  return out;
}

/**
 * Compose a system prompt that prepends behavioural-skill bodies to the
 * agent's own system prompt. Order: skills (in allowlist order) then agent.
 */
export function composeSystemPrompt(
  agentSystemPrompt: string,
  skills: RenderedBehaviouralSkill[],
): string {
  if (skills.length === 0) return agentSystemPrompt;
  const sections = skills.map(
    (s) => `<behavioural-skill name="${s.name}">\n${s.body.trim()}\n</behavioural-skill>`,
  );
  return [...sections, agentSystemPrompt.trim()].join('\n\n');
}

/** Strip a leading YAML frontmatter block delimited by --- lines. */
function stripFrontmatter(raw: string): string {
  if (!raw.startsWith('---')) return raw;
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return raw;
  return raw.slice(end + 4).replace(/^\n+/, '');
}
