import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { buildArgs, type SessionInvocation } from './invocation.js';
import {
  extractAssistantText,
  isAssistant,
  isResult,
  isSystemInit,
  type StreamEvent,
} from './events.js';

export type SessionResult = {
  /** Final assistant text — last assistant message, falling back to the `result` event. */
  text: string;
  /** Session UUID, either pre-allocated or captured from the init event. */
  sessionId?: string;
  /** All parsed stream-json events. */
  events: StreamEvent[];
  /** Process exit code. */
  exitCode: number;
  /** stderr drained from the process; surfaced when exitCode != 0. */
  stderr: string;
};

export type DryRun = {
  binary: string;
  args: string[];
  /** Shell-quoted single-line for human inspection. */
  display: string;
};

export class SessionDriver {
  /** Build the command without spawning it. */
  dryRun(inv: SessionInvocation): DryRun {
    const { binary, args } = buildArgs(inv);
    return { binary, args, display: shellQuote([binary, ...args]) };
  }

  /**
   * Spawn the agent and run it to completion. `onEvent`, when supplied, is
   * called for every parsed stream-json event as it arrives — used to
   * stream live progress into the journal.
   */
  async run(
    inv: SessionInvocation,
    onEvent?: (event: StreamEvent) => void,
  ): Promise<SessionResult> {
    const { binary, args } = buildArgs(inv);

    const child = spawn(binary, args, {
      cwd: inv.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const events: StreamEvent[] = [];
    let assistantText = '';
    let resultText = '';
    let sessionId = inv.sessionId;
    let stderr = '';

    const stdoutLines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    stdoutLines.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: StreamEvent;
      try {
        event = JSON.parse(trimmed) as StreamEvent;
      } catch {
        // Non-JSON line: surface it to stderr so the user can debug,
        // but don't crash the driver.
        stderr += `[non-json stdout] ${trimmed}\n`;
        return;
      }
      events.push(event);
      if (isSystemInit(event) && event.session_id) {
        sessionId = event.session_id;
      } else if (isAssistant(event)) {
        const text = extractAssistantText(event);
        if (text) assistantText = text; // keep only the latest assistant message
      } else if (isResult(event)) {
        if (typeof event.result === 'string') resultText = event.result;
        if (event.session_id) sessionId = event.session_id;
      }
      onEvent?.(event);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
      child.on('error', rejectExit);
      child.on('close', (code) => resolveExit(code ?? 0));
    });

    // Prefer the explicit `result` event when present (it's what Claude Code
    // considers the canonical final answer); fall back to the last assistant
    // text we saw.
    const text = resultText || assistantText;

    return { text, sessionId, events, exitCode, stderr };
  }
}

function shellQuote(parts: string[]): string {
  return parts
    .map((p) => {
      if (p === '') return "''";
      if (/^[A-Za-z0-9_\-./:=,@%+]+$/.test(p)) return p;
      return `'${p.replaceAll("'", `'\\''`)}'`;
    })
    .join(' ');
}
