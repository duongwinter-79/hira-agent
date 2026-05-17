import { randomUUID } from 'node:crypto';
import type { LoadedAgent, LoadedSkill } from '@hira/plugin-loader';
import type { Handoff } from '@hira/journal';
import type { Journal } from '@hira/journal';
import {
  composeSystemPrompt,
  loadBehaviouralSkills,
  prepareAgentIsolation,
  type SessionInvocation,
  type SessionResult,
} from '@hira/session';
import { extractFencedJson } from './fence.js';

/**
 * Minimal driver surface the Bus depends on. The real implementation is
 * `SessionDriver` from `@hira/session`; tests can pass a stub that returns a
 * synthetic `SessionResult` so unit coverage doesn't require burning quota.
 */
export type BusDriver = {
  run(invocation: SessionInvocation): Promise<SessionResult>;
};

export type BusConfig = {
  agents: LoadedAgent[];
  skills: LoadedSkill[];
  journal: Journal;
  projectRoot: string;
  driver: BusDriver;
  binary: string;
};

export type DispatchResult = {
  /** Parsed fenced JSON from the agent's reply, or null if none found / malformed. */
  response: unknown | null;
  /** Full assistant text (includes the fenced block). */
  responseText: string;
  /** Claude Code session UUID, if captured. */
  sessionId?: string;
  /** Process exit code from the spawned `claude` invocation. */
  exitCode: number;
  /** Excerpt of stderr (first 2 KB) on failures, undefined otherwise. */
  stderrExcerpt?: string;
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
  constructor(private readonly cfg: BusConfig) {}

  async dispatch(envelope: Handoff): Promise<DispatchResult> {
    const target = this.cfg.agents.find((a) => a.manifest.name === envelope.to);
    if (!target) {
      throw new Error(`Bus: unknown target agent '${envelope.to}'`);
    }
    this.checkEscalation(envelope.from, envelope.to);

    const behavioural = await loadBehaviouralSkills(this.cfg.skills, target.manifest.skills);
    const systemPrompt = composeSystemPrompt(target.systemPrompt, behavioural);

    const runDir = this.cfg.journal.runDir(envelope.run_id);
    const isolation = await prepareAgentIsolation({
      runDir,
      agentName: target.manifest.name,
      allowedTools: target.manifest.tools,
    });

    await this.cfg.journal.recordHandoffStart(envelope);

    const result = await this.cfg.driver.run({
      binary: this.cfg.binary,
      prompt: renderPromptForHandoff(envelope),
      systemPrompt,
      allowedTools: target.manifest.tools,
      permissionMode: 'acceptEdits',
      cwd: this.cfg.projectRoot,
      sessionId: randomUUID(),
      noSessionPersistence: true,
      outputFormat: 'stream-json',
      settingSources: [],
      settingsPath: isolation.settingsPath,
    });

    const response = extractFencedJson(result.text);
    const stderrExcerpt = result.stderr.slice(0, 2048) || undefined;

    await this.cfg.journal.completeHandoff(envelope.run_id, envelope.handoff_id, {
      status: result.exitCode === 0 ? 'completed' : 'failed',
      session_id: result.sessionId,
      response,
      response_text: result.text,
      exit_code: result.exitCode,
      stderr_excerpt: stderrExcerpt,
    });

    return {
      response,
      responseText: result.text,
      sessionId: result.sessionId,
      exitCode: result.exitCode,
      stderrExcerpt,
    };
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
