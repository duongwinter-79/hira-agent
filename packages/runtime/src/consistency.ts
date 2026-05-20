/**
 * Cross-Artifact Consistency check (SPEC §4.8).
 *
 * A read-only check over a Planner task graph + the Architect's ADR +
 * baseline memory, run as a gate before the Developer is dispatched.
 *
 * Severity policy (resolves SPEC §12 #15):
 *  - `blocker`  — structural defects that make the plan unexecutable:
 *                 no tasks, empty descriptions, unknown owners, dangling
 *                 dependencies, dependency cycles. These block dispatch.
 *  - `warning`  — a new ADR overlaps an existing baseline decision.
 *                 Surfaced, never blocking — duplication/conflict is a
 *                 judgement call for the user.
 *
 * Ambiguity detection ("vague acceptance criteria") is deliberately out
 * of scope: it needs model judgement, not a deterministic rule, so it is
 * left to the Planner's and Architect's own reasoning.
 */

export type ConsistencySeverity = 'blocker' | 'warning';

export type ConsistencyIssue = {
  severity: ConsistencySeverity;
  kind:
    | 'no-tasks'
    | 'empty-description'
    | 'unknown-owner'
    | 'dangling-dependency'
    | 'cycle'
    | 'related-prior-decision';
  message: string;
};

export type ConsistencyReport = {
  status: 'pass' | 'warnings' | 'blocked';
  issues: ConsistencyIssue[];
};

export type ConsistencyTask = {
  id: string;
  description: string;
  owner: string;
  depends_on: string[];
};

export type ConsistencyAdr = {
  title?: string;
  tags?: string[];
};

export type BaselineAdr = {
  id: string;
  title: string;
  tags: string[];
};

export type ConsistencyInput = {
  tasks: ConsistencyTask[];
  /** The Architect's ADR for this Run, if one has been produced. */
  adr?: ConsistencyAdr | null;
  /** Baseline `adr`-kind memory records to compare the new ADR against. */
  baselineAdrs: BaselineAdr[];
  /** Every known agent name — owners outside this set are a blocker. */
  knownOwners: Set<string>;
};

/** Significant-token overlap at or above this count flags a related ADR. */
const ADR_OVERLAP_THRESHOLD = 3;

export function checkConsistency(input: ConsistencyInput): ConsistencyReport {
  const issues: ConsistencyIssue[] = [];
  const { tasks } = input;

  if (tasks.length === 0) {
    issues.push({
      severity: 'blocker',
      kind: 'no-tasks',
      message: 'The plan contains no tasks.',
    });
  }

  const ids = new Set(tasks.map((t) => t.id));
  for (const t of tasks) {
    if (!t.description.trim()) {
      issues.push({
        severity: 'blocker',
        kind: 'empty-description',
        message: `Task '${t.id}' has an empty description.`,
      });
    }
    if (!input.knownOwners.has(t.owner)) {
      issues.push({
        severity: 'blocker',
        kind: 'unknown-owner',
        message: `Task '${t.id}' has owner '${t.owner}', which is not a known agent.`,
      });
    }
    for (const dep of t.depends_on) {
      if (!ids.has(dep)) {
        issues.push({
          severity: 'blocker',
          kind: 'dangling-dependency',
          message: `Task '${t.id}' depends on '${dep}', which is not in the plan.`,
        });
      }
    }
  }

  if (tasks.length > 0 && hasCycle(tasks)) {
    issues.push({
      severity: 'blocker',
      kind: 'cycle',
      message: 'The task graph contains a dependency cycle.',
    });
  }

  if (input.adr) {
    const newTokens = adrTokens(input.adr.title, input.adr.tags);
    for (const prior of input.baselineAdrs) {
      const priorTokens = adrTokens(prior.title, prior.tags);
      const overlap = [...newTokens].filter((tok) => priorTokens.has(tok));
      if (overlap.length >= ADR_OVERLAP_THRESHOLD) {
        issues.push({
          severity: 'warning',
          kind: 'related-prior-decision',
          message: `The new ADR overlaps prior decision '${prior.id}' ("${prior.title}") on [${overlap.join(', ')}]. Check for duplication or conflict.`,
        });
      }
    }
  }

  const blocked = issues.some((i) => i.severity === 'blocker');
  const warnings = issues.some((i) => i.severity === 'warning');
  return {
    status: blocked ? 'blocked' : warnings ? 'warnings' : 'pass',
    issues,
  };
}

/** Significant tokens from an ADR title + tags (lowercase, length ≥ 4). */
function adrTokens(title?: string, tags?: string[]): Set<string> {
  const out = new Set<string>();
  for (const w of (title ?? '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length >= 4) out.add(w);
  }
  for (const tag of tags ?? []) {
    for (const w of tag.toLowerCase().split(/[^a-z0-9]+/)) {
      if (w.length >= 3) out.add(w);
    }
  }
  return out;
}

function hasCycle(tasks: ConsistencyTask[]): boolean {
  const indeg = new Map<string, number>();
  const ids = new Set(tasks.map((t) => t.id));
  for (const t of tasks) {
    // Only count dependencies that actually exist — dangling deps are
    // reported separately and must not be mistaken for a cycle.
    indeg.set(t.id, t.depends_on.filter((d) => ids.has(d)).length);
  }
  const ready = tasks.filter((t) => (indeg.get(t.id) ?? 0) === 0).map((t) => t.id);
  let resolved = 0;
  while (ready.length > 0) {
    const next = ready.shift()!;
    resolved++;
    for (const t of tasks) {
      if (t.depends_on.includes(next)) {
        const deg = (indeg.get(t.id) ?? 0) - 1;
        indeg.set(t.id, deg);
        if (deg === 0) ready.push(t.id);
      }
    }
  }
  return resolved !== tasks.length;
}
