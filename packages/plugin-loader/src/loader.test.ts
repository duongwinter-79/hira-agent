import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlugins } from './loader.js';

async function makeRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'hira-'));
}

async function writeAgent(root: string, name: string, yaml: string, prompt = `# ${name}`) {
  const dir = join(root, 'plugins', 'agents', name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'agent.yaml'), yaml);
  await writeFile(join(dir, 'system.md'), prompt);
}

describe('loadPlugins', () => {
  it('discovers and validates agent manifests', async () => {
    const root = await makeRoot();
    await writeAgent(
      root,
      'developer',
      [
        'name: developer',
        'version: 0.1.0',
        'kind: agent',
        'prompt: ./system.md',
        'tools: [Read, Edit]',
        'escalates_to: []',
      ].join('\n'),
      'You are the developer.\n',
    );

    const plugins = await loadPlugins(root);

    expect(plugins.agents).toHaveLength(1);
    expect(plugins.agents[0]!.manifest.name).toBe('developer');
    expect(plugins.agents[0]!.systemPrompt).toContain('developer');
    expect(plugins.agents[0]!.manifest.session.mode).toBe('fresh');
  });

  it('rejects invalid manifests', async () => {
    const root = await makeRoot();
    const dir = join(root, 'plugins', 'agents', 'broken');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'agent.yaml'), 'kind: agent\n');

    await expect(loadPlugins(root)).rejects.toThrow(/Invalid agent manifest/);
  });

  it('rejects escalates_to references to unknown agents', async () => {
    const root = await makeRoot();
    await writeAgent(
      root,
      'planner',
      [
        'name: planner',
        'version: 0.0.1',
        'kind: agent',
        'prompt: ./system.md',
        'escalates_to: [ghost]',
      ].join('\n'),
    );

    await expect(loadPlugins(root)).rejects.toThrow(/unknown agent 'ghost'/);
  });

  it('returns empty results when plugins dir is missing', async () => {
    const root = await makeRoot();
    const plugins = await loadPlugins(root);
    expect(plugins.agents).toEqual([]);
    expect(plugins.skills).toEqual([]);
  });

  it("reads an agent's outputs.schema into LoadedAgent.outputSchema", async () => {
    const root = await makeRoot();
    await writeAgent(
      root,
      'planner',
      [
        'name: planner',
        'version: 0.0.1',
        'kind: agent',
        'prompt: ./system.md',
        'outputs:',
        '  schema: ./outputs.schema.json',
        'escalates_to: []',
      ].join('\n'),
    );
    const dir = join(root, 'plugins', 'agents', 'planner');
    await writeFile(
      join(dir, 'outputs.schema.json'),
      JSON.stringify({ type: 'object', required: ['tasks'] }),
    );
    const plugins = await loadPlugins(root);
    expect(plugins.agents[0]!.outputSchema).toEqual({ type: 'object', required: ['tasks'] });
  });

  it('rejects an agent whose outputs.schema file is missing', async () => {
    const root = await makeRoot();
    await writeAgent(
      root,
      'planner',
      [
        'name: planner',
        'version: 0.0.1',
        'kind: agent',
        'prompt: ./system.md',
        'outputs:',
        '  schema: ./outputs.schema.json',
        'escalates_to: []',
      ].join('\n'),
    );
    await expect(loadPlugins(root)).rejects.toThrow(/outputs\.schema.*missing/);
  });

  it('parses a skill manifest with an mcp block', async () => {
    const root = await makeRoot();
    const dir = join(root, 'plugins', 'skills', 'spec-consistency');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'skill.yaml'),
      ['name: spec-consistency', 'version: 1.0.0', 'kind: skill', 'mcp:', '  tool: spec_consistency_check'].join('\n'),
    );
    const plugins = await loadPlugins(root);
    expect(plugins.skills).toHaveLength(1);
    expect(plugins.skills[0]!.manifest.mcp).toEqual({ tool: 'spec_consistency_check' });
  });
});
