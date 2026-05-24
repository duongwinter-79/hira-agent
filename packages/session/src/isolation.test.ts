import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareAgentIsolation } from './isolation.js';

async function makeRunDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'hira-run-'));
}

describe('prepareAgentIsolation', () => {
  it('creates the agent directory and writes settings.json', async () => {
    const runDir = await makeRunDir();
    const result = await prepareAgentIsolation({
      runDir,
      agentName: 'orchestrator',
      allowedTools: [],
    });

    expect(result.agentDir).toBe(join(runDir, 'orchestrator'));
    expect(result.settingsPath).toBe(join(runDir, 'orchestrator', 'settings.json'));
    expect((await stat(result.agentDir)).isDirectory()).toBe(true);
    expect((await stat(result.settingsPath)).isFile()).toBe(true);
  });

  it('writes an empty hooks object so inherited hooks cannot fire', async () => {
    const runDir = await makeRunDir();
    const { settingsPath } = await prepareAgentIsolation({
      runDir,
      agentName: 'developer',
      allowedTools: ['Read', 'Edit'],
    });
    const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    expect(settings.hooks).toEqual({});
  });

  it('mirrors the tool allowlist into permissions.allow', async () => {
    const runDir = await makeRunDir();
    const { settingsPath } = await prepareAgentIsolation({
      runDir,
      agentName: 'developer',
      allowedTools: ['Read', 'Edit', 'Bash'],
    });
    const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    expect(settings.permissions.allow).toEqual(['Read', 'Edit', 'Bash']);
  });

  it('creates nested run directories on demand', async () => {
    const base = await makeRunDir();
    const runDir = join(base, 'runs', 'abc-123');
    const { agentDir } = await prepareAgentIsolation({
      runDir,
      agentName: 'planner',
      allowedTools: [],
    });
    expect((await stat(agentDir)).isDirectory()).toBe(true);
  });

  it('writes mcp.json when an MCP server is requested', async () => {
    const runDir = await makeRunDir();
    const result = await prepareAgentIsolation({
      runDir,
      agentName: 'planner',
      allowedTools: ['Read', 'mcp__hira-skills__spec_consistency_check'],
      mcpServer: {
        name: 'hira-skills',
        command: 'node',
        args: ['/install/server.js'],
        env: { HIRA_PROJECT_ROOT: '/proj' },
      },
    });
    expect(result.mcpConfigPath).toBe(join(result.agentDir, 'mcp.json'));
    const mcp = JSON.parse(await readFile(result.mcpConfigPath!, 'utf8'));
    expect(mcp.mcpServers['hira-skills'].command).toBe('node');
    expect(mcp.mcpServers['hira-skills'].args).toEqual(['/install/server.js']);
    expect(mcp.mcpServers['hira-skills'].env.HIRA_PROJECT_ROOT).toBe('/proj');
  });

  it('omits mcp.json when no MCP server is requested', async () => {
    const runDir = await makeRunDir();
    const result = await prepareAgentIsolation({
      runDir,
      agentName: 'planner',
      allowedTools: [],
    });
    expect(result.mcpConfigPath).toBeUndefined();
  });
});
