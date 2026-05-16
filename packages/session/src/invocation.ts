export type PermissionMode =
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'default'
  | 'plan'
  | 'auto'
  | 'dontAsk';

export type SessionInvocation = {
  /** Path to the `claude` CLI binary. */
  binary: string;
  /** Prompt / hand-off envelope text passed positionally. */
  prompt: string;
  /** Replaces Claude Code's default system prompt. */
  systemPrompt?: string;
  /** Tool allowlist for this invocation. Empty array = no tools allowed. */
  allowedTools?: string[];
  /** Tool denylist applied on top of the allowlist. */
  disallowedTools?: string[];
  /** Permission mode; Hira defaults to acceptEdits for headless runs. */
  permissionMode?: PermissionMode;
  /** Working directory for the spawned process. */
  cwd?: string;
  /** Pre-allocated session UUID so we don't have to capture it from output. */
  sessionId?: string;
  /** Resume an existing session by id (warm mode). */
  resume?: string;
  /** Advisory model hint; subscription plan has the final say. */
  model?: string;
  /** Don't save the session to disk (avoids polluting the user's session list). */
  noSessionPersistence?: boolean;
  /** Path(s) to MCP config files to load. */
  mcpConfig?: string[];
  /** Output format. Hira defaults to stream-json. */
  outputFormat?: 'stream-json' | 'json' | 'text';
};

/**
 * Build the argv for spawning `claude`. Pure function — no I/O, no spawn.
 * Returns the binary plus its arguments; the caller hands them to
 * child_process.spawn.
 */
export function buildArgs(inv: SessionInvocation): { binary: string; args: string[] } {
  const args: string[] = ['-p'];

  if (inv.resume) {
    args.push('--resume', inv.resume);
  } else if (inv.sessionId) {
    args.push('--session-id', inv.sessionId);
  }

  // System prompt is only meaningful for fresh sessions. Resuming a session
  // would just append it as user-visible noise.
  if (inv.systemPrompt && !inv.resume) {
    args.push('--system-prompt', inv.systemPrompt);
  }

  if (inv.allowedTools) {
    if (inv.allowedTools.length === 0) {
      // Disable every built-in tool.
      args.push('--tools', '');
    } else {
      args.push('--allowedTools', inv.allowedTools.join(','));
    }
  }

  if (inv.disallowedTools && inv.disallowedTools.length > 0) {
    args.push('--disallowedTools', inv.disallowedTools.join(','));
  }

  if (inv.permissionMode) {
    args.push('--permission-mode', inv.permissionMode);
  }

  if (inv.model) {
    args.push('--model', inv.model);
  }

  if (inv.noSessionPersistence) {
    args.push('--no-session-persistence');
  }

  if (inv.mcpConfig && inv.mcpConfig.length > 0) {
    args.push('--mcp-config', ...inv.mcpConfig);
  }

  const outputFormat = inv.outputFormat ?? 'stream-json';
  args.push('--output-format', outputFormat);
  if (outputFormat === 'stream-json') {
    args.push('--verbose'); // stream-json requires verbose
  }

  args.push(inv.prompt);

  return { binary: inv.binary, args };
}
