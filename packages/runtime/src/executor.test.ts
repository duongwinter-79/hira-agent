import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal, type Handoff } from '@hira/journal';
import type { LoadedAgent } from '@hira/plugin-loader';
import type { SessionInvocation, SessionResult } from '@hira/session';
import { Bus, type BusDriver } from './bus.js';
import { Executor, type PlannerTask } from './executor.js';

function agent(name: string): LoadedAgent {
  return {
    dir: '/fake/' + name,
    systemPrompt: `You are ${name}.`,
    manifest: {
      name,
      version: '0.0.1',
      kind: 'agent',
      prompt: './system.md',
      skills: [],
      tools: ['Read', 'Edit', 'Write', 'Bash'],
      escalates_to: [],
      budgets: { max_turns: 40, max_tokens: 200_000 },
      session: { mode: 'fresh' },
    },
  };
}

type Call = { invocation: SessionInvocation };

function recordingDriver(replyByAgentName: Record<string, string>): {
  driver: BusDriver;
  calls: Call[];
} {
  const calls: Call[] = [];
  const driver: BusDriver = {
    async run(invocation: SessionInvocation): Promise<SessionResult> {
      calls.push({ invocation });
      // Identify target from systemPrompt's first sentence ("You are X.").
      const m = invocation.systemPrompt?.match(/You are ([\w-]+)\./);
      const name = m?.[1] ?? 'unknown';
      return {
        text: replyByAgentName[name] ?? '```json\n{}\n```',
        sessionId: `sess-${name}`,
        events: [],
        exitCode: 0,
        stderr: '',
      };
    },
  };
  return { driver, calls };
}

async function newRun(): Promise<{ journal: Journal; runId: string; projectRoot: string }> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'hira-exec-'));
  const journal = new Journal(projectRoot);
  const run = await journal.openRun('test');
  return { journal, runId: run.id, projectRoot };
}

const plannerTasks: PlannerTask[] = [
  { id: 't1', description: 'survey libs', owner: 'knowledge', depends_on: [] },
  { id: 't2', description: 'design', owner: 'solution-architect', depends_on: ['t1'] },
  { id: 't3', description: 'implement', owner: 'developer', depends_on: ['t2'] },
];

describe('Executor', () => {
  it('dispatches tasks to wired owners in dependency order', async () => {
    const { journal, runId, projectRoot } = await newRun();
    const { driver, calls } = recordingDriver({
      knowledge: '```json\n{"facts":[],"summary":"k done"}\n```',
      'solution-architect': '```json\n{"decision":"use X"}\n```',
    });
    const bus = new Bus({
      agents: [agent('knowledge'), agent('solution-architect'), agent('developer')],
      skills: [],
      journal,
      projectRoot,
      driver,
      binary: 'claude',
    });

    const exec = new Executor({
      bus,
      journal,
      projectRoot,
      wiredOwners: new Set(['knowledge', 'solution-architect']),
    });

    const out = await exec.run({ runId, parentHandoffId: 'parent-1', tasks: plannerTasks });

    expect(out.graph_error).toBeUndefined();
    expect(out.executions).toHaveLength(3);

    const [t1, t2, t3] = out.executions;
    expect(t1!.task.id).toBe('t1');
    expect(t1!.status).toBe('completed');
    expect(t1!.response).toEqual({ facts: [], summary: 'k done' });

    expect(t2!.task.id).toBe('t2');
    expect(t2!.status).toBe('completed');

    expect(t3!.task.id).toBe('t3');
    expect(t3!.status).toBe('skipped');
    expect(t3!.skip_reason).toMatch(/owner 'developer' is not wired/);

    // Order of calls follows topo order.
    expect(calls).toHaveLength(2);
    expect(calls[0]!.invocation.systemPrompt).toContain('knowledge');
    expect(calls[1]!.invocation.systemPrompt).toContain('solution-architect');
  });

  it('passes dependency responses into each task envelope', async () => {
    const { journal, runId, projectRoot } = await newRun();
    const { driver, calls } = recordingDriver({
      knowledge: '```json\n{"summary":"k1"}\n```',
      'solution-architect': '```json\n{"decision":"d1"}\n```',
    });
    const bus = new Bus({
      agents: [agent('knowledge'), agent('solution-architect')],
      skills: [],
      journal,
      projectRoot,
      driver,
      binary: 'claude',
    });
    const exec = new Executor({
      bus,
      journal,
      projectRoot,
      wiredOwners: new Set(['knowledge', 'solution-architect']),
    });

    await exec.run({ runId, parentHandoffId: 'p', tasks: plannerTasks.slice(0, 2) });

    // The architect's prompt should contain the knowledge response.
    const architectPrompt = calls[1]!.invocation.prompt;
    expect(architectPrompt).toContain('"task_id": "t1"');
    expect(architectPrompt).toContain('"summary": "k1"');
  });

  it('applies the executor-level tools override on every dispatch', async () => {
    const { journal, runId, projectRoot } = await newRun();
    const { driver, calls } = recordingDriver({
      knowledge: '```json\n{}\n```',
    });
    const bus = new Bus({
      agents: [agent('knowledge')],
      skills: [],
      journal,
      projectRoot,
      driver,
      binary: 'claude',
    });
    const exec = new Executor({
      bus,
      journal,
      projectRoot,
      wiredOwners: new Set(['knowledge']),
      toolsOverride: ['Read', 'Grep'],
    });

    await exec.run({
      runId,
      parentHandoffId: 'p',
      tasks: [{ id: 't1', description: 'x', owner: 'knowledge', depends_on: [] }],
    });

    expect(calls[0]!.invocation.allowedTools).toEqual(['Read', 'Grep']);
  });

  it('detects cycles and returns graph_error without dispatching', async () => {
    const { journal, runId, projectRoot } = await newRun();
    const { driver, calls } = recordingDriver({});
    const bus = new Bus({
      agents: [agent('knowledge')],
      skills: [],
      journal,
      projectRoot,
      driver,
      binary: 'claude',
    });
    const exec = new Executor({
      bus,
      journal,
      projectRoot,
      wiredOwners: new Set(['knowledge']),
    });
    const cyclic: PlannerTask[] = [
      { id: 'a', description: '', owner: 'knowledge', depends_on: ['b'] },
      { id: 'b', description: '', owner: 'knowledge', depends_on: ['a'] },
    ];
    const out = await exec.run({ runId, parentHandoffId: 'p', tasks: cyclic });
    expect(out.graph_error).toMatch(/cycle/);
    expect(out.executions).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('detects unknown dependency ids', async () => {
    const { journal, runId, projectRoot } = await newRun();
    const { driver } = recordingDriver({});
    const bus = new Bus({
      agents: [agent('knowledge')],
      skills: [],
      journal,
      projectRoot,
      driver,
      binary: 'claude',
    });
    const exec = new Executor({
      bus,
      journal,
      projectRoot,
      wiredOwners: new Set(['knowledge']),
    });
    const out = await exec.run({
      runId,
      parentHandoffId: 'p',
      tasks: [{ id: 'a', description: '', owner: 'knowledge', depends_on: ['ghost'] }],
    });
    expect(out.graph_error).toMatch(/unknown task 'ghost'/);
  });

  it('injects memoryContext into every task payload', async () => {
    const { journal, runId, projectRoot } = await newRun();
    const { driver, calls } = recordingDriver({
      knowledge: '```json\n{}\n```',
    });
    const bus = new Bus({
      agents: [agent('knowledge')],
      skills: [],
      journal,
      projectRoot,
      driver,
      binary: 'claude',
    });
    const memoryContext = [
      {
        id: 'adr:1',
        kind: 'adr' as const,
        title: 'Use sqlite',
        body: 'Decision body',
        tags: ['storage'],
        created_at: '2026-05-01T00:00:00Z',
        updated_at: '2026-05-01T00:00:00Z',
      },
    ];
    const exec = new Executor({
      bus,
      journal,
      projectRoot,
      wiredOwners: new Set(['knowledge']),
      memoryContext,
    });
    await exec.run({
      runId,
      parentHandoffId: 'p',
      tasks: [{ id: 't1', description: 'x', owner: 'knowledge', depends_on: [] }],
    });
    const promptText = calls[0]!.invocation.prompt;
    expect(promptText).toContain('memory_context');
    expect(promptText).toContain('adr:1');
    expect(promptText).toContain('Use sqlite');
  });

  it('verification seam reports skipped when no config is supplied', async () => {
    const { journal, runId, projectRoot } = await newRun();
    const { driver } = recordingDriver({
      developer: '```json\n{"summary":"impl"}\n```',
    });
    const bus = new Bus({
      agents: [agent('developer')],
      skills: [],
      journal,
      projectRoot,
      driver,
      binary: 'claude',
    });
    const exec = new Executor({
      bus,
      journal,
      projectRoot,
      wiredOwners: new Set(['developer']),
    });

    const out = await exec.run({
      runId,
      parentHandoffId: 'p',
      tasks: [{ id: 't1', description: 'implement', owner: 'developer', depends_on: [] }],
    });

    expect(out.executions[0]!.verification?.status).toBe('skipped');
    const data = await journal.getRun(runId);
    const verArtifacts = data!.artifacts.filter((a) => a.kind === 'verification');
    expect(verArtifacts).toHaveLength(1);
    expect(verArtifacts[0]!.handoff_id).toBe(out.executions[0]!.handoff_id);
  });

  it('verification seam runs configured checks and gates on failure', async () => {
    const { journal, runId, projectRoot } = await newRun();
    const { driver } = recordingDriver({
      developer: '```json\n{"summary":"impl"}\n```',
    });
    const bus = new Bus({
      agents: [agent('developer')],
      skills: [],
      journal,
      projectRoot,
      driver,
      binary: 'claude',
    });
    const exec = new Executor({
      bus,
      journal,
      projectRoot,
      wiredOwners: new Set(['developer']),
      verificationConfig: {
        checks: [
          { name: 'green', command: 'exit 0' },
          { name: 'red', command: 'exit 1' },
        ],
      },
    });

    const out = await exec.run({
      runId,
      parentHandoffId: 'p',
      tasks: [{ id: 't1', description: 'implement', owner: 'developer', depends_on: [] }],
    });

    const report = out.executions[0]!.verification;
    expect(report?.status).toBe('fail');
    expect(report?.stages.map((s) => `${s.name}:${s.status}`)).toEqual([
      'green:pass',
      'red:fail',
    ]);
  });

  it('retries the Developer once when verification fails', async () => {
    const { journal, runId, projectRoot } = await newRun();
    const { driver, calls } = recordingDriver({
      developer: '```json\n{"summary":"impl"}\n```',
    });
    const bus = new Bus({
      agents: [agent('developer')],
      skills: [],
      journal,
      projectRoot,
      driver,
      binary: 'claude',
    });
    const exec = new Executor({
      bus,
      journal,
      projectRoot,
      wiredOwners: new Set(['developer']),
      verificationConfig: { checks: [{ name: 'always-red', command: 'exit 1' }] },
    });

    const out = await exec.run({
      runId,
      parentHandoffId: 'p',
      tasks: [{ id: 't1', description: 'implement', owner: 'developer', depends_on: [] }],
    });

    // Developer dispatched twice: initial attempt + one retry.
    expect(calls.filter((c) => c.invocation.systemPrompt?.includes('developer'))).toHaveLength(2);
    expect(out.executions[0]!.attempts).toBe(2);
    expect(out.executions[0]!.verification?.status).toBe('fail');
  });

  it('hard-gates downstream tasks when verification keeps failing', async () => {
    const { journal, runId, projectRoot } = await newRun();
    const { driver } = recordingDriver({
      developer: '```json\n{"summary":"impl"}\n```',
      reviewer: '```json\n{"verdict":"approve"}\n```',
    });
    const bus = new Bus({
      agents: [agent('developer'), agent('reviewer')],
      skills: [],
      journal,
      projectRoot,
      driver,
      binary: 'claude',
    });
    const exec = new Executor({
      bus,
      journal,
      projectRoot,
      wiredOwners: new Set(['developer', 'reviewer']),
      verificationConfig: { checks: [{ name: 'always-red', command: 'exit 1' }] },
    });

    const out = await exec.run({
      runId,
      parentHandoffId: 'p',
      tasks: [
        { id: 't1', description: 'implement', owner: 'developer', depends_on: [] },
        { id: 't2', description: 'review', owner: 'reviewer', depends_on: ['t1'] },
      ],
    });

    expect(out.gate_failed).toBe(true);
    const reviewerExec = out.executions.find((e) => e.task.id === 't2');
    expect(reviewerExec!.status).toBe('skipped');
    expect(reviewerExec!.skip_reason).toMatch(/Verification Engine gate failed/);
  });

  it('runs downstream tasks normally when verification passes', async () => {
    const { journal, runId, projectRoot } = await newRun();
    const { driver } = recordingDriver({
      developer: '```json\n{"summary":"impl"}\n```',
      reviewer: '```json\n{"verdict":"approve"}\n```',
    });
    const bus = new Bus({
      agents: [agent('developer'), agent('reviewer')],
      skills: [],
      journal,
      projectRoot,
      driver,
      binary: 'claude',
    });
    const exec = new Executor({
      bus,
      journal,
      projectRoot,
      wiredOwners: new Set(['developer', 'reviewer']),
      verificationConfig: { checks: [{ name: 'always-green', command: 'exit 0' }] },
    });

    const out = await exec.run({
      runId,
      parentHandoffId: 'p',
      tasks: [
        { id: 't1', description: 'implement', owner: 'developer', depends_on: [] },
        { id: 't2', description: 'review', owner: 'reviewer', depends_on: ['t1'] },
      ],
    });

    expect(out.gate_failed).toBeUndefined();
    expect(out.executions[0]!.attempts).toBe(1);
    expect(out.executions.find((e) => e.task.id === 't2')!.status).toBe('completed');
  });

  it('consistency gate blocks dispatch when the plan has an unknown owner', async () => {
    const { journal, runId, projectRoot } = await newRun();
    const { driver } = recordingDriver({ developer: '```json\n{"summary":"impl"}\n```' });
    const bus = new Bus({
      agents: [agent('developer')],
      skills: [],
      journal,
      projectRoot,
      driver,
      binary: 'claude',
    });
    const exec = new Executor({
      bus,
      journal,
      projectRoot,
      wiredOwners: new Set(['developer']),
      knownOwners: new Set(['developer', 'knowledge', 'solution-architect']),
    });

    const out = await exec.run({
      runId,
      parentHandoffId: 'p',
      tasks: [
        { id: 't1', description: 'do frontend', owner: 'frontend-wizard', depends_on: [] },
        { id: 't2', description: 'implement', owner: 'developer', depends_on: ['t1'] },
      ],
    });

    expect(out.consistency_blocked).toBe(true);
    expect(out.consistency?.status).toBe('blocked');
    const devExec = out.executions.find((e) => e.task.id === 't2');
    expect(devExec!.status).toBe('skipped');
    expect(devExec!.skip_reason).toMatch(/Consistency gate blocked/);
  });

  it('consistency gate passes a clean plan and lets the Developer run', async () => {
    const { journal, runId, projectRoot } = await newRun();
    const { driver } = recordingDriver({ developer: '```json\n{"summary":"impl"}\n```' });
    const bus = new Bus({
      agents: [agent('developer')],
      skills: [],
      journal,
      projectRoot,
      driver,
      binary: 'claude',
    });
    const exec = new Executor({
      bus,
      journal,
      projectRoot,
      wiredOwners: new Set(['developer']),
      knownOwners: new Set(['developer']),
    });

    const out = await exec.run({
      runId,
      parentHandoffId: 'p',
      tasks: [{ id: 't1', description: 'implement', owner: 'developer', depends_on: [] }],
    });

    expect(out.consistency_blocked).toBeUndefined();
    expect(out.consistency?.status).toBe('pass');
    expect(out.executions[0]!.status).toBe('completed');
  });
});

// Silence unused-import lint when no helper happens to use Handoff directly.
void (null as unknown as Handoff);
