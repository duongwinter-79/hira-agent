import { randomUUID } from 'node:crypto';
import type { LoadedAgent, LoadedSkill } from '@hira/plugin-loader';
import type { Handoff } from '@hira/journal';
import type { Journal } from '@hira/journal';
import {
  composeSystemPrompt,
  extractAssistantText,
  isAssistant,
  isSystemInit,
  loadBehaviouralSkills,
  prepareAgentIsolation,
  resolveMcpSkills,
  type SessionInvocation,
  type SessionResult,
  type StreamEvent,
} from '@hira/session';
import Ajv, { type ValidateFunction } from 'ajv';
import { extractFencedJson } from './fence.js';
import { BudgetTracker } from './budget.js';

/**
 * Minimal driver surface the Bus depends on. The real implementation is
 * `SessionDriver` from `@hira/session`; tests can pass a stub that returns a
 * synthetic `SessionResult` so unit coverage doesn't require burning quota.
 *
 * `onEvent` streams parsed stream-json events as they arrive — the Bus uses
 * it to journal live progress.
 */
export type BusDriver = {
  run(
    invocation: SessionInvocation,
    onEvent?: (event: StreamEvent) => void,
  ): Promise<SessionResult>;
};

export type BusConfig = {
  agents: LoadedAgent[];
  skills: LoadedSkill[];
  journal: Journal;
  projectRoot: string;
  driver: BusDriver;
  binary: string;
  /**
   * Path to the built `@hira/mcp-skills` server (`dist/server.js`). When
   * set, agents whose skill allowlist includes an MCP skill get the
   * `hira-skills` MCP server mounted via `--mcp-config` (SPEC §4.6).
   * Undefined → MCP skills are silently inert.
   */
  mcpSkillsServerPath?: string;
  /**
   * Per-Run budget tracker (SPEC §9). Bus calls `check()` before every
   * dispatch and `recordHandoff()` after a successful send. Undefined →
   * no per-Run caps enforced.
   */
  budget?: BudgetTracker;
};

/** Name of Hira's built-in MCP server, as it appears in mcp.json. */
const HIRA_MCP_SERVER = 'hira-skills';

export type DispatchResult = {
  /**
   * Parsed fenced JSON from the agent's reply, or null when no fenced block
   * was found, the JSON was malformed, OR it failed `outputs.schema`
   * validation (in which case `schemaError` is set).
   */
  response: unknown | null;
  /** Full assistant text (includes the fenced block). */
  responseText: string;
  /** Claude Code session UUID, if captured. */
  sessionId?: string;
  /** Process exit code from the spawned `claude` invocation. */
  exitCode: number;
  /** Excerpt of stderr (first 2 KB) on failures, undefined otherwise. */
  stderrExcerpt?: string;
  /**
   * Schema-validation error when the agent's `response` failed its
   * declared `outputs.schema`. The hand-off completed cleanly otherwise;
   * the response was discarded.
   */
  schemaError?: string;
};

export type DispatchOptions = {
  /**
   * Override the target agent's manifest tool allowlist for this single
   * dispatch. Used by the Executor to keep most specialists read-only
   * while giving the Developer real Edit/Write/Bash inside its worktree.
   *
   * The override REPLACES the manifest list — pass `[]` to disable every
   * built-in tool. Omit to use the manifest's tools verbatim.
   */
  tools?: string[];
  /**
   * Override the working directory for this single dispatch. Used by the
   * Executor to run worktree-scoped agents (Developer / Tester / Reviewer)
   * inside `.hira/runs/<run_id>/worktree/` instead of the project root.
   */
  cwd?: string;
};

/**
 * Brokers a single hand-off:
 *   - validates the target exists and the source is allowed to escalate to it,
 *   - prepares per-agent isolation under `.hira/runs/<run_id>/<agent>/`,
 *   - composes the agent's effective system prompt (own prompt + behavioural skills),
 *   - frames the envelope as the prompt,
 *   - journals start → spawn → completion,
 *   - extracts the fenced JSON reply,
 *   - returns a structured DispatchResult.
 *
 * The orchestrator and the human user can broker any pair; other agents are
 * limited to the targets in their manifest's `escalates_to`.
 */
export class Bus {
  private readonly ajv: Ajv;
  private readonly validators = new Map<string, ValidateFunction>();

  constructor(private readonly cfg: BusConfig) {
    this.ajv = new Ajv({ allErrors: false, strict: false });
  }

  async dispatch(envelope: Handoff, options: DispatchOptions = {}): Promise<DispatchResult> {
    // Per-Run budget check (SPEC §9). Throws BudgetExhausted if a cap is hit.
    this.cfg.budget?.check();

    const target = this.cfg.agents.find((a) => a.manifest.name === envelope.to);
    if (!target) {
      throw new Error(`Bus: unknown target agent '${envelope.to}'`);
    }
    this.checkEscalation(envelope.from, envelope.to);

    const behavioural = await loadBehaviouralSkills(this.cfg.skills, target.manifest.skills);
    const systemPrompt = composeSystemPrompt(target.systemPrompt, behavioural);

    const baseTools = options.tools ?? target.manifest.tools;
    const cwd = options.cwd ?? this.cfg.projectRoot;

    // Mount Hira's MCP server when the agent's allowlist includes an MCP
    // skill (SPEC §4.6). The tool names go into the allowlist so the
    // headless agent can call them without a permission prompt.
    const mcpSkills = this.cfg.mcpSkillsServerPath
      ? resolveMcpSkills(this.cfg.skills, target.manifest.skills)
      : [];
    const mcpToolNames = mcpSkills.map((s) => `mcp__${HIRA_MCP_SERVER}__${s.tool}`);
    const allowedTools = mcpToolNames.length > 0 ? [...baseTools, ...mcpToolNames] : baseTools;

    const runDir = this.cfg.journal.runDir(envelope.run_id);
    const isolation = await prepareAgentIsolation({
      runDir,
      agentName: target.manifest.name,
      allowedTools,
      ...(mcpSkills.length > 0 && this.cfg.mcpSkillsServerPath
        ? {
            mcpServer: {
              name: HIRA_MCP_SERVER,
              command: 'node',
              args: [this.cfg.mcpSkillsServerPath],
              env: { HIRA_PROJECT_ROOT: this.cfg.projectRoot },
            },
          }
        : {}),
    });

    await this.cfg.journal.recordHandoffStart(envelope);

    // Stream live progress into the journal so a hand-off that never
    // completes (a crash) still shows how far the agent got.
    const onEvent = (event: StreamEvent): void => {
      const progress = deriveProgress(event);
      if (progress) {
        void this.cfg.journal.recordHandoffProgress(
          envelope.run_id,
          envelope.handoff_id,
          progress.phase,
          progress.detail,
        );
      }
    };

    const result = await this.cfg.driver.run(
      {
        binary: this.cfg.binary,
        prompt: renderPromptForHandoff(envelope),
        systemPrompt,
        allowedTools,
        permissionMode: 'acceptEdits',
        cwd,
        sessionId: randomUUID(),
        noSessionPersistence: true,
        outputFormat: 'stream-json',
        settingSources: [],
        settingsPath: isolation.settingsPath,
        ...(isolation.mcpConfigPath ? { mcpConfig: [isolation.mcpConfigPath] } : {}),
      },
      onEvent,
    );

    this.cfg.budget?.recordHandoff();

    const rawResponse = extractFencedJson(result.text);
    const stderrExcerpt = result.stderr.slice(0, 2048) || undefined;

    // Validate against the target's outputs.schema (SPEC M3.a). On
    // failure the response is discarded (null) and the error is journaled
    // so `runs show` surfaces it — same tolerant convention as malformed
    // JSON, just with a precise message.
    let response = rawResponse;
    let schemaError: string | undefined;
    if (rawResponse !== null && target.outputSchema) {
      const validate = this.validatorFor(target.manifest.name, target.outputSchema);
      if (!validate(rawResponse)) {
        schemaError = formatAjvErrors(validate.errors);
        response = null;
      }
    }

    await this.cfg.journal.completeHandoff(envelope.run_id, envelope.handoff_id, {
      status: result.exitCode === 0 ? 'completed' : 'failed',
      session_id: result.sessionId,
      response,
      response_text: result.text,
      exit_code: result.exitCode,
      stderr_excerpt: stderrExcerpt,
      ...(schemaError !== undefined ? { schema_error: schemaError } : {}),
    });

    return {
      response,
      responseText: result.text,
      sessionId: result.sessionId,
      exitCode: result.exitCode,
      stderrExcerpt,
      ...(schemaError !== undefined ? { schemaError } : {}),
    };
  }

  /** Cached schema validator per agent (compile once per Bus instance). */
  private validatorFor(agentName: string, schema: unknown): ValidateFunction {
    let v = this.validators.get(agentName);
    if (!v) {
      v = this.ajv.compile(schema as object);
      this.validators.set(agentName, v);
    }
    return v;
  }

  private checkEscalation(from: string, to: string): void {
    // The user and the orchestrator can broker any pair.
    if (from === 'user' || from === 'orchestrator') return;
    const source = this.cfg.agents.find((a) => a.manifest.name === from);
    if (!source) {
      throw new Error(`Bus: unknown source agent '${from}'`);
    }
    if (!source.manifest.escalates_to.includes(to)) {
      throw new Error(
        `Bus: agent '${from}' is not allowed to escalate to '${to}' (manifest.escalates_to: [${source.manifest.escalates_to.join(', ')}])`,
      );
    }
  }
}

/**
 * Frame a hand-off envelope as a prompt for the target agent.
 *
 * For user → orchestrator, the user's plain text message is the prompt —
 * no envelope chrome. For agent → agent, the payload is JSON-serialised
 * inside a short framing message so the target knows where the input came
 * from. Agents' system prompts tell them how to respond (a fenced JSON
 * block), so we don't repeat that here.
 */
function renderPromptForHandoff(envelope: Handoff): string {
  if (envelope.from === 'user') {
    const payload = envelope.payload as { message?: unknown };
    if (typeof payload?.message === 'string') return payload.message;
    return typeof envelope.payload === 'string'
      ? envelope.payload
      : JSON.stringify(envelope.payload);
  }
  const payloadText =
    typeof envelope.payload === 'string'
      ? envelope.payload
      : JSON.stringify(envelope.payload, null, 2);
  return [
    `Hand-off ${envelope.handoff_id} from '${envelope.from}' (kind: ${envelope.kind}).`,
    '',
    'Payload:',
    payloadText,
  ].join('\n');
}

/**
 * Project a stream-json event into a compact journal progress entry, or
 * null for events not worth journaling (user echoes, tool results, the
 * final result — which `completeHandoff` already captures).
 */
function deriveProgress(event: StreamEvent): { phase: string; detail?: string } | null {
  if (isSystemInit(event)) {
    return { phase: 'started', ...(event.session_id ? { detail: event.session_id } : {}) };
  }
  if (isAssistant(event)) {
    const blocks = event.message?.content ?? [];
    const tools = blocks
      .filter((b) => b.type === 'tool_use')
      .map((b) => (b as { name?: unknown }).name)
      .filter((n): n is string => typeof n === 'string');
    if (tools.length > 0) {
      return { phase: 'tool', detail: tools.join(', ') };
    }
    const text = extractAssistantText(event).replace(/\s+/g, ' ').trim();
    if (text) {
      return { phase: 'message', detail: text.length > 80 ? text.slice(0, 77) + '...' : text };
    }
  }
  return null;
}

/** Render Ajv's error array into a short, actionable one-line message. */
function formatAjvErrors(errors: ValidateFunction['errors']): string {
  if (!errors || errors.length === 0) return 'schema validation failed';
  const parts = errors.slice(0, 3).map((e) => {
    const where = e.instancePath || '/';
    return `${where} ${e.message ?? 'invalid'}`;
  });
  const more = errors.length > 3 ? ` (+${errors.length - 3} more)` : '';
  return parts.join('; ') + more;
}
