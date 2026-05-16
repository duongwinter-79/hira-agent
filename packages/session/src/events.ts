/**
 * Claude Code `--output-format stream-json` event shapes.
 *
 * Only the fields Hira consumes are typed; everything else passes through
 * as `unknown` in a permissive wrapper so unknown event types don't crash
 * the driver. Schema may drift across CLI versions — keep parsing tolerant.
 */

export type SystemInitEvent = {
  type: 'system';
  subtype: 'init';
  session_id?: string;
  model?: string;
  tools?: string[];
};

export type AssistantContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id?: string; name?: string; input?: unknown }
  | { type: string; [k: string]: unknown };

export type AssistantEvent = {
  type: 'assistant';
  message?: {
    content?: AssistantContentBlock[];
  };
};

export type ResultEvent = {
  type: 'result';
  subtype?: 'success' | 'error_max_turns' | 'error_during_execution' | string;
  result?: string;
  is_error?: boolean;
  session_id?: string;
};

export type StreamEvent =
  | SystemInitEvent
  | AssistantEvent
  | ResultEvent
  | { type: string; [k: string]: unknown };

export function isSystemInit(e: StreamEvent): e is SystemInitEvent {
  return e.type === 'system' && (e as SystemInitEvent).subtype === 'init';
}

export function isAssistant(e: StreamEvent): e is AssistantEvent {
  return e.type === 'assistant';
}

export function isResult(e: StreamEvent): e is ResultEvent {
  return e.type === 'result';
}

export function extractAssistantText(e: AssistantEvent): string {
  const blocks = e.message?.content ?? [];
  return blocks
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof (b as { text?: unknown }).text === 'string')
    .map((b) => b.text)
    .join('');
}
