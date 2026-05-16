import { describe, it, expect } from 'vitest';
import { buildArgs } from './invocation.js';

describe('buildArgs', () => {
  it('emits the minimal print invocation', () => {
    const { binary, args } = buildArgs({ binary: 'claude', prompt: 'hello' });
    expect(binary).toBe('claude');
    expect(args[0]).toBe('-p');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--verbose');
    expect(args.at(-1)).toBe('hello');
  });

  it('passes system prompt and pre-allocated session id', () => {
    const { args } = buildArgs({
      binary: 'claude',
      prompt: 'hi',
      systemPrompt: 'You are the orchestrator.',
      sessionId: '00000000-0000-0000-0000-000000000001',
    });
    expect(args).toContain('--system-prompt');
    expect(args).toContain('You are the orchestrator.');
    expect(args).toContain('--session-id');
    expect(args).toContain('00000000-0000-0000-0000-000000000001');
  });

  it('disables all tools when allowedTools is empty', () => {
    const { args } = buildArgs({ binary: 'claude', prompt: 'hi', allowedTools: [] });
    const i = args.indexOf('--tools');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe('');
    expect(args).not.toContain('--allowedTools');
  });

  it('comma-joins allowedTools', () => {
    const { args } = buildArgs({
      binary: 'claude',
      prompt: 'hi',
      allowedTools: ['Read', 'Edit', 'Bash'],
    });
    const i = args.indexOf('--allowedTools');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe('Read,Edit,Bash');
  });

  it('uses --resume and drops --system-prompt for warm sessions', () => {
    const { args } = buildArgs({
      binary: 'claude',
      prompt: 'next turn',
      systemPrompt: 'should be ignored',
      resume: 'abc',
      sessionId: 'xyz', // should be ignored too — resume wins
    });
    expect(args).toContain('--resume');
    expect(args).toContain('abc');
    expect(args).not.toContain('--system-prompt');
    expect(args).not.toContain('--session-id');
  });

  it('adds --no-session-persistence when requested', () => {
    const { args } = buildArgs({
      binary: 'claude',
      prompt: 'hi',
      noSessionPersistence: true,
    });
    expect(args).toContain('--no-session-persistence');
  });

  it('appends mcp config paths', () => {
    const { args } = buildArgs({
      binary: 'claude',
      prompt: 'hi',
      mcpConfig: ['/tmp/a.json', '/tmp/b.json'],
    });
    const i = args.indexOf('--mcp-config');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe('/tmp/a.json');
    expect(args[i + 2]).toBe('/tmp/b.json');
  });

  it('passes the model flag through', () => {
    const { args } = buildArgs({ binary: 'claude', prompt: 'hi', model: 'opus' });
    expect(args).toContain('--model');
    expect(args).toContain('opus');
  });
});
