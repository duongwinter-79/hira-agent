import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Per-Run budget enforcement (SPEC §9). The Bus calls `tracker.check()`
 * before every dispatch; if a budget is exceeded a `BudgetExhausted`
 * exception aborts the Run cleanly.
 */

export type Budget = {
  /** Maximum hand-off dispatches in this Run. Omit → no cap. */
  max_handoffs?: number;
  /** Maximum wall-clock seconds for the Run. Omit → no cap. */
  max_wall_clock_s?: number;
};

/** Thrown by `BudgetTracker.check()` when any configured limit is hit. */
export class BudgetExhausted extends Error {
  constructor(public readonly reason: string) {
    super(`Run budget exhausted: ${reason}`);
    this.name = 'BudgetExhausted';
  }
}

export class BudgetTracker {
  private handoffs = 0;
  private readonly startedAt: number;

  constructor(
    private readonly budget: Budget,
    startedAt = Date.now(),
  ) {
    this.startedAt = startedAt;
  }

  /** Throws BudgetExhausted if a limit is reached. Call before each dispatch. */
  check(): void {
    if (
      this.budget.max_handoffs !== undefined &&
      this.handoffs >= this.budget.max_handoffs
    ) {
      throw new BudgetExhausted(
        `max_handoffs ${this.budget.max_handoffs} reached`,
      );
    }
    if (this.budget.max_wall_clock_s !== undefined) {
      const elapsedMs = Date.now() - this.startedAt;
      if (elapsedMs >= this.budget.max_wall_clock_s * 1000) {
        throw new BudgetExhausted(
          `max_wall_clock_s ${this.budget.max_wall_clock_s} exceeded (elapsed ${Math.floor(elapsedMs / 1000)}s)`,
        );
      }
    }
  }

  /** Record that a hand-off has been dispatched. Call after `check()` passes. */
  recordHandoff(): void {
    this.handoffs++;
  }

  snapshot(): { handoffs: number; elapsed_ms: number } {
    return { handoffs: this.handoffs, elapsed_ms: Date.now() - this.startedAt };
  }
}

/**
 * Load the `budgets.per_run` block from <projectRoot>/hira.config.json.
 * Returns null when absent or malformed — caller treats null as "no caps".
 */
export async function loadBudgetConfig(projectRoot: string): Promise<Budget | null> {
  const raw = await readFile(join(projectRoot, 'hira.config.json'), 'utf8').catch(() => null);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const block = (parsed as { budgets?: { per_run?: unknown } }).budgets?.per_run;
  if (!block || typeof block !== 'object') return null;
  const b = block as Budget;
  const out: Budget = {};
  if (typeof b.max_handoffs === 'number' && b.max_handoffs > 0) {
    out.max_handoffs = b.max_handoffs;
  }
  if (typeof b.max_wall_clock_s === 'number' && b.max_wall_clock_s > 0) {
    out.max_wall_clock_s = b.max_wall_clock_s;
  }
  return out.max_handoffs !== undefined || out.max_wall_clock_s !== undefined ? out : null;
}
