import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal, type Handoff } from '@hira/journal';
import type { LoadedAgent, LoadedSkill } from '@hira/plugin-loader';
import type { SessionInvocation, SessionResult } from '@hira/session';
import { Bus, type BusDriver } from './bus.js';

function agent(name: string, escalates_to: string[] = []): LoadedAgent {
  return {
    dir: '/fake/' + name,
    systemPrompt: `You are ${name}.`,
    manifest: {
      name,
      version: '0.0.1',
      kind: 'agent',
      prompt: './system.md',
      skills: [],
      tools: [],
      escalates_to,
      budgets: { max_turns: 40, max_tokens: 200_000 },
      session: { mode: 'fresh' },
    },
  };
}

function makeBus(opts: {
  agents: LoadedAgent[];
  skills?: LoadedSkill[];
  driver: BusDriver;
  journal: Journal;
  projectRoot: string;
}): Bus {
  return new Bus({
    agents: opts.agents,
    skills: opts.skills ?? [],
    journal: opts.journal,
    projectRoot: opts.projectRoot,
    driver: opts.driver,
    binary: 'claude',
  });
}

function makeHandoff(from: string, to: string, runId: string): Handoff {
  return {
    run_id: runId,
    handoff_id: `h-${Math.random().toString(36).slice(2, 8)}`,
    from,
    to,
    kind: 'request',
    payload: { message: 'hi' },
    artifacts: [],
    delta_refs: [],
  };
}

function fakeDriver(text: string, opts: { exitCode?: number; sessionId?: string } = {}): BusDriver {
  return {
    async run(_invocation: SessionInvocation): Promise<SessionResult> {
      return {
        text,
        sessionId: opts.sessionId ?? 'sess-test',
        events: [],
        exitCode: opts.exitCode ?? 0,
        stderr: '',
      };
    },
  };
}

describe('Bus.dispatch', () => {
  it('dispatches user → orchestrator and extracts fenced JSON', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'hira-bus-'));
    const journal = new Journal(projectRoot);
    const run = await journal.openRun('test');

    const bus = makeBus({
      agents: [agent('orchestrator')],
      driver: fakeDriver('Reasoning.\n\n```json\n{"action":"reply","message":"hi"}\n```'),
      journal,
      projectRoot,
    });

    const result = await bus.dispatch(makeHandoff('user', 'orchestrator', run.id));

    expect(result.exitCode).toBe(0);
    expect(result.response).toEqual({ action: 'reply', message: 'hi' });
    expect(result.sessionId).toBe('sess-test');

    const data = await journal.getRun(run.id);
    expect(data!.handoffs).toHaveLength(1);
    expect(data!.handoffs[0]!.status).toBe('completed');
    expect(data!.handoffs[0]!.response).toEqual({ action: 'reply', message: 'hi' });
  });

  it('throws when the target agent is not loaded', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'hira-bus-'));
    const journal = new Journal(projectRoot);
    const run = await journal.openRun('test');
    const bus = makeBus({
      agents: [agent('orchestrator')],
      driver: fakeDriver(''),
      journal,
      projectRoot,
    });
    await expect(bus.dispatch(makeHandoff('user', 'ghost', run.id))).rejects.toThrow(
      /unknown target agent 'ghost'/,
    );
  });

  it('lets the orchestrator broker any pair regardless of escalates_to', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'hira-bus-'));
    const journal = new Journal(projectRoot);
    const run = await journal.openRun('test');
    const bus = makeBus({
      agents: [agent('orchestrator'), agent('planner', [])],
      driver: fakeDriver('```json\n{"tasks":[]}\n```'),
      journal,
      projectRoot,
    });
    await expect(
      bus.dispatch(makeHandoff('orchestrator', 'planner', run.id)),
    ).resolves.toBeDefined();
  });

  it("enforces escalates_to for non-orchestrator sources", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'hira-bus-'));
    const journal = new Journal(projectRoot);
    const run = await journal.openRun('test');
    const bus = makeBus({
      // developer can only escalate to reviewer; not knowledge.
      agents: [agent('developer', ['reviewer']), agent('knowledge')],
      driver: fakeDriver(''),
      journal,
      projectRoot,
    });
    await expect(bus.dispatch(makeHandoff('developer', 'knowledge', run.id))).rejects.toThrow(
      /'developer' is not allowed to escalate to 'knowledge'/,
    );
  });

  it('marks the hand-off failed when the spawned process exits non-zero', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'hira-bus-'));
    const journal = new Journal(projectRoot);
    const run = await journal.openRun('test');
    const bus = makeBus({
      agents: [agent('orchestrator')],
      driver: fakeDriver('boom', { exitCode: 1 }),
      journal,
      projectRoot,
    });

    const result = await bus.dispatch(makeHandoff('user', 'orchestrator', run.id));
    expect(result.exitCode).toBe(1);

    const data = await journal.getRun(run.id);
    expect(data!.handoffs[0]!.status).toBe('failed');
    expect(data!.handoffs[0]!.exit_code).toBe(1);
  });

  it('returns response=null when no fenced JSON is present (tolerant)', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'hira-bus-'));
    const journal = new Journal(projectRoot);
    const run = await journal.openRun('test');
    const bus = makeBus({
      agents: [agent('orchestrator')],
      driver: fakeDriver('just prose, no fenced block'),
      journal,
      projectRoot,
    });
    const result = await bus.dispatch(makeHandoff('user', 'orchestrator', run.id));
    expect(result.response).toBeNull();
    expect(result.responseText).toBe('just prose, no fenced block');
  });
});
