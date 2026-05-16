import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  AgentManifestSchema,
  SkillManifestSchema,
  type AgentManifest,
  type SkillManifest,
} from './manifest.js';

export type LoadedAgent = {
  manifest: AgentManifest;
  dir: string;
  systemPrompt: string;
};

export type LoadedSkill = {
  manifest: SkillManifest;
  dir: string;
};

export type LoadedPlugins = {
  agents: LoadedAgent[];
  skills: LoadedSkill[];
};

export async function loadPlugins(root: string): Promise<LoadedPlugins> {
  const pluginsRoot = resolve(root, 'plugins');
  const agents = await loadAgents(join(pluginsRoot, 'agents'));
  const skills = await loadSkills(join(pluginsRoot, 'skills'));
  validateCrossReferences(agents);
  return { agents, skills };
}

async function loadAgents(dir: string): Promise<LoadedAgent[]> {
  const entries = await safeReaddir(dir);
  const agents: LoadedAgent[] = [];
  for (const entry of entries) {
    const agentDir = join(dir, entry);
    if (!(await isDir(agentDir))) continue;
    const manifestPath = join(agentDir, 'agent.yaml');
    const raw = await readFile(manifestPath, 'utf8').catch(() => null);
    if (raw === null) continue;
    const parsed = parseYaml(raw);
    const result = AgentManifestSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`Invalid agent manifest at ${manifestPath}: ${result.error.message}`);
    }
    const manifest = result.data;
    const promptPath = resolve(agentDir, manifest.prompt);
    const systemPrompt = await readFile(promptPath, 'utf8').catch(() => '');
    agents.push({ manifest, dir: agentDir, systemPrompt });
  }
  return agents.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

async function loadSkills(dir: string): Promise<LoadedSkill[]> {
  const entries = await safeReaddir(dir);
  const skills: LoadedSkill[] = [];
  for (const entry of entries) {
    const skillDir = join(dir, entry);
    if (!(await isDir(skillDir))) continue;
    const manifestPath = join(skillDir, 'skill.yaml');
    const raw = await readFile(manifestPath, 'utf8').catch(() => null);
    if (raw === null) continue;
    const parsed = parseYaml(raw);
    const result = SkillManifestSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`Invalid skill manifest at ${manifestPath}: ${result.error.message}`);
    }
    skills.push({ manifest: result.data, dir: skillDir });
  }
  return skills.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

function validateCrossReferences(agents: LoadedAgent[]): void {
  const names = new Set(agents.map((a) => a.manifest.name));
  for (const a of agents) {
    for (const target of a.manifest.escalates_to) {
      if (!names.has(target)) {
        throw new Error(
          `Agent '${a.manifest.name}' escalates_to unknown agent '${target}'.`,
        );
      }
    }
  }
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
