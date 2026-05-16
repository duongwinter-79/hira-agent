/**
 * End-to-end test: actually spawns `claude` and asserts agent isolation
 * works. Skipped by default because it burns subscription quota and
 * requires a working `claude login`. Run with:
 *
 *   HIRA_E2E=1 pnpm --filter @hira/session test
 */

import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionDriver } from './driver.js';
import { prepareAgentIsolation } from './isolation.js';

const enabled = process.env.HIRA_E2E === '1';

describe.skipIf(!enabled)('SessionDriver (e2e, requires claude login)', () => {
  it('isolated agent ignores host stop hooks and answers the prompt', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'hira-e2e-'));
    const isolation = await prepareAgentIsolation({
      runDir,
      agentName: 'orchestrator',
      allowedTools: [],
    });

    const driver = new SessionDriver();
    const result = await driver.run({
      binary: 'claude',
      prompt: 'Reply with exactly the four-letter string PONG, nothing else.',
      systemPrompt:
        'You are a test agent. Answer the user literally. Do not mention git, ' +
        'commits, hooks, or repository state.',
      allowedTools: [],
      permissionMode: 'acceptEdits',
      noSessionPersistence: true,
      outputFormat: 'stream-json',
      settingSources: [],
      settingsPath: isolation.settingsPath,
    });

    expect(result.exitCode).toBe(0);
    expect(result.text.trim()).toBe('PONG');
  }, 90_000);
});
