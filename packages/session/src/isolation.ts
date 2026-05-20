import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** An MCP server to mount into an agent's session (SPEC §4.6). */
export type McpServerConfig = {
  /** Server name as it appears in mcp.json's `mcpServers` map. */
  name: string;
  /** Executable to spawn. */
  command: string;
  /** Arguments to the executable. */
  args: string[];
  /** Environment variables for the server process. */
  env?: Record<string, string>;
};

export type IsolationRequest = {
  /** Absolute path to `.hira/runs/<run_id>/` for this Run. */
  runDir: string;
  /** Agent name (used as a sub-directory). */
  agentName: string;
  /**
   * Tool allowlist for this agent. Mirrored into the settings file's
   * `permissions.allow` so headless invocations don't prompt.
   */
  allowedTools: string[];
  /** Optional MCP server to mount for this agent (written to mcp.json). */
  mcpServer?: McpServerConfig;
};

export type IsolationArtifacts = {
  /** Per-agent directory inside the Run journal. */
  agentDir: string;
  /** Absolute path to the generated settings.json. */
  settingsPath: string;
  /** Absolute path to the generated mcp.json, when an MCP server was requested. */
  mcpConfigPath?: string;
};

/**
 * Create a per-agent isolation directory inside the Run journal and write a
 * minimal settings.json that:
 *   - has no `hooks` (so inherited Stop/PreToolUse/etc. cannot fire),
 *   - pre-approves the agent's tool allowlist (no permission prompts in
 *     headless mode),
 *   - declares `$schema` so editors can validate it.
 *
 * When `mcpServer` is supplied, also writes an mcp.json the runtime passes
 * via `--mcp-config`, mounting the model-callable skill (SPEC §4.6).
 *
 * Combined with `SessionInvocation.settingSources = []` this gives an agent
 * subprocess that is fully isolated from the host's `~/.claude/settings.json`
 * and the project's `.claude/`.
 */
export async function prepareAgentIsolation(
  req: IsolationRequest,
): Promise<IsolationArtifacts> {
  const agentDir = join(req.runDir, req.agentName);
  await mkdir(agentDir, { recursive: true });

  const settings = {
    $schema: 'https://json.schemastore.org/claude-code-settings.json',
    hooks: {},
    permissions: {
      allow: [...req.allowedTools],
    },
  };

  const settingsPath = join(agentDir, 'settings.json');
  await writeFile(settingsPath, JSON.stringify(settings, null, 2));

  let mcpConfigPath: string | undefined;
  if (req.mcpServer) {
    const mcpConfig = {
      mcpServers: {
        [req.mcpServer.name]: {
          command: req.mcpServer.command,
          args: req.mcpServer.args,
          ...(req.mcpServer.env ? { env: req.mcpServer.env } : {}),
        },
      },
    };
    mcpConfigPath = join(agentDir, 'mcp.json');
    await writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
  }

  return { agentDir, settingsPath, ...(mcpConfigPath ? { mcpConfigPath } : {}) };
}
