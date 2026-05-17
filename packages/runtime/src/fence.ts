/**
 * Extract structured output from an agent's reply.
 *
 * Convention from SPEC §6: every agent ends its reply with a fenced ```json
 * block. Freeform prose before the block is reasoning the journal keeps
 * but the bus ignores.
 *
 * If there are multiple fenced blocks, the LAST one wins — the agent's
 * final answer. If the last block fails to parse, returns null rather than
 * throwing; the bus surfaces malformed output as a `failed` hand-off.
 */
export function extractFencedJson(text: string): unknown | null {
  const re = /```(?:json)?\s*\n([\s\S]*?)\n```/g;
  let lastBody: string | null = null;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    lastBody = match[1] ?? null;
  }
  if (lastBody === null) return null;
  try {
    return JSON.parse(lastBody);
  } catch {
    return null;
  }
}
