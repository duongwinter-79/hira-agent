export {
  loadPlugins,
  AgentManifestSchema,
  SkillManifestSchema,
} from '@hira/plugin-loader';
export type {
  AgentManifest,
  SkillManifest,
  LoadedAgent,
  LoadedSkill,
  LoadedPlugins,
} from '@hira/plugin-loader';

export {
  SessionDriver,
  buildArgs,
  isAssistant,
  isResult,
  isSystemInit,
  extractAssistantText,
  prepareAgentIsolation,
  loadBehaviouralSkills,
  composeSystemPrompt,
} from '@hira/session';
export type {
  SessionInvocation,
  SessionResult,
  DryRun,
  PermissionMode,
  StreamEvent,
  SystemInitEvent,
  AssistantEvent,
  ResultEvent,
  IsolationRequest,
  IsolationArtifacts,
  RenderedBehaviouralSkill,
} from '@hira/session';

export {
  Journal,
  HandoffSchema,
  HandoffKindSchema,
  ArtifactSchema,
  VerificationReportSchema,
} from '@hira/journal';
export type {
  Handoff,
  HandoffKind,
  HandoffStatus,
  HandoffRecord,
  RunRecord,
  RunStatus,
  Artifact,
  VerificationReport,
} from '@hira/journal';

export { Bus } from './bus.js';
export type { BusConfig, BusDriver, DispatchResult, DispatchOptions } from './bus.js';
export { extractFencedJson } from './fence.js';
export { Executor } from './executor.js';
export type {
  ExecutorConfig,
  ExecutorInput,
  ExecutorOutput,
  PlannerTask,
  TaskExecution,
} from './executor.js';
export {
  verifyDeveloperHandoff,
  runVerificationEngine,
  loadVerificationConfig,
} from './verification.js';
export type {
  VerificationConfig,
  VerificationCheck,
  VerificationEngineOptions,
} from './verification.js';

export {
  isGitRepo,
  createRunWorktree,
  runWorktreeSetup,
  finalizeWorktree,
  loadWorktreeSetupCommand,
  deleteRunBranch,
} from './worktree.js';
export type { RunWorktree, WorktreeOutcome } from './worktree.js';

export { buildRunTrace, traceArtifact } from './trace.js';
export type { RunTrace, TracedTask, FramingHandoff, ArtifactTrace } from './trace.js';

export { writeMemoryDelta, readMemoryDelta } from './delta.js';

export { checkConsistency } from './consistency.js';
export type {
  ConsistencyReport,
  ConsistencyIssue,
  ConsistencySeverity,
  ConsistencyTask,
  ConsistencyAdr,
  ConsistencyInput,
  BaselineAdr,
} from './consistency.js';

export { MemoryStore, MemoryRecordSchema, NewMemoryRecordSchema, MemoryKindSchema } from '@hira/memory';
export type { MemoryRecord, NewMemoryRecord, MemoryKind, MemorySource } from '@hira/memory';
