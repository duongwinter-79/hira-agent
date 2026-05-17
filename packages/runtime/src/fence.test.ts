import { describe, it, expect } from 'vitest';
import { extractFencedJson } from './fence.js';

describe('extractFencedJson', () => {
  it('returns null when no fenced block exists', () => {
    expect(extractFencedJson('just prose')).toBeNull();
  });

  it('parses a single fenced block tagged as json', () => {
    const out = extractFencedJson('Reasoning.\n\n```json\n{"action":"reply"}\n```');
    expect(out).toEqual({ action: 'reply' });
  });

  it('parses an untagged fenced block too', () => {
    const out = extractFencedJson('```\n{"x":1}\n```');
    expect(out).toEqual({ x: 1 });
  });

  it('takes the LAST fenced block when multiple are present', () => {
    const text = '```json\n{"first":true}\n```\nmore prose\n```json\n{"last":true}\n```';
    expect(extractFencedJson(text)).toEqual({ last: true });
  });

  it('returns null when the last block is not valid JSON', () => {
    expect(extractFencedJson('```json\n{not json}\n```')).toBeNull();
  });

  it('handles nested objects and arrays', () => {
    const out = extractFencedJson('```json\n{"tasks":[{"id":"t1"}]}\n```');
    expect(out).toEqual({ tasks: [{ id: 't1' }] });
  });
});
