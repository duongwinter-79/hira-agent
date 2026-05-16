import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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
};

export type IsolationArtifacts = {
  /** Per-agent directory inside the Run journal. */
  agentDir: string;
  /** Absolute path to the generated settings.json. */
  settingsPath: string;
};

/**
 * Create a per-agent isolation directory inside the Run journal and write a
 * minimal settings.json that:
 *   - has no `hooks` (so inherited Stop/PreToolUse/etc. cannot fire),
 *   - pre-approves the agent's tool allowlist (no permission prompts in
 *     headless mode),
 *   - declares `$schema` so editors can validate it.
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

  return { agentDir, settingsPath };
}
