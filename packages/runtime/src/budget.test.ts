import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetTracker, BudgetExhausted, loadBudgetConfig } from './budget.js';

async function tmpProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'hira-budget-'));
}

describe('BudgetTracker', () => {
  it('passes check() when no caps are set', () => {
    const t = new BudgetTracker({});
    t.check();
    t.recordHandoff();
    t.check();
    expect(t.snapshot().handoffs).toBe(1);
  });

  it('throws BudgetExhausted when max_handoffs is reached', () => {
    const t = new BudgetTracker({ max_handoffs: 2 });
    t.check(); t.recordHandoff();
    t.check(); t.recordHandoff();
    expect(() => t.check()).toThrow(BudgetExhausted);
    expect(() => t.check()).toThrow(/max_handoffs 2/);
  });

  it('throws BudgetExhausted when wall-clock is exceeded', () => {
    const pastStart = Date.now() - 10_000;
    const t = new BudgetTracker({ max_wall_clock_s: 5 }, pastStart);
    expect(() => t.check()).toThrow(/max_wall_clock_s/);
  });

  it('the exception carries a human-readable reason', () => {
    const t = new BudgetTracker({ max_handoffs: 1 });
    t.check(); t.recordHandoff();
    try {
      t.check();
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetExhausted);
      expect((err as BudgetExhausted).reason).toMatch(/max_handoffs/);
    }
  });
});

describe('loadBudgetConfig', () => {
  it('returns null when hira.config.json is absent', async () => {
    expect(await loadBudgetConfig(await tmpProject())).toBeNull();
  });

  it('returns null when there is no budgets block', async () => {
    const root = await tmpProject();
    await writeFile(join(root, 'hira.config.json'), JSON.stringify({ verification: {} }));
    expect(await loadBudgetConfig(root)).toBeNull();
  });

  it('parses max_handoffs and max_wall_clock_s', async () => {
    const root = await tmpProject();
    await writeFile(
      join(root, 'hira.config.json'),
      JSON.stringify({ budgets: { per_run: { max_handoffs: 30, max_wall_clock_s: 600 } } }),
    );
    expect(await loadBudgetConfig(root)).toEqual({
      max_handoffs: 30,
      max_wall_clock_s: 600,
    });
  });

  it('drops non-positive or non-numeric values', async () => {
    const root = await tmpProject();
    await writeFile(
      join(root, 'hira.config.json'),
      JSON.stringify({
        budgets: { per_run: { max_handoffs: 0, max_wall_clock_s: 'soon' } },
      }),
    );
    expect(await loadBudgetConfig(root)).toBeNull();
  });
});
