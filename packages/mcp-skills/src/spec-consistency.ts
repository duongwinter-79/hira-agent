import { MemoryStore } from '@hira/memory';
import {
  checkConsistency,
  type ConsistencyAdr,
  type ConsistencyReport,
  type ConsistencyTask,
} from '@hira/runtime';

/**
 * `spec_consistency_check` — the Cross-Artifact Consistency check (SPEC
 * §4.8) exposed as a model-callable skill. The runtime runs the same
 * `checkConsistency` as a gate; this tool lets the Planner and Architect
 * self-check before they hand off.
 */

/** The Hira built-in agent roster — owners outside it are flagged. */
const DEFAULT_KNOWN_OWNERS = [
  'orchestrator',
  'planner',
  'solution-architect',
  'developer',
  'tester',
  'reviewer',
  'knowledge',
  'memory',
];

export type SpecConsistencyArgs = {
  tasks: ConsistencyTask[];
  adr?: ConsistencyAdr | null;
  /** Override the known-owner roster; defaults to the Hira built-ins. */
  known_owners?: string[];
};

/**
 * Run the consistency check for a proposed plan + ADR. Baseline ADRs are
 * read from the project's memory store at `projectRoot`.
 */
export async function runSpecConsistencyTool(
  args: SpecConsistencyArgs,
  projectRoot: string,
): Promise<ConsistencyReport> {
  const store = new MemoryStore(projectRoot);
  const baselineAdrs = (await store.list({ kind: 'adr' })).map((r) => ({
    id: r.id,
    title: r.title,
    tags: r.tags,
  }));
  return checkConsistency({
    tasks: args.tasks,
    adr: args.adr ?? null,
    baselineAdrs,
    knownOwners: new Set(args.known_owners ?? DEFAULT_KNOWN_OWNERS),
  });
}
