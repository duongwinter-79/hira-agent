# Hira Agent — Project Specification

> A multi-agent orchestration layer built on top of Claude Code sessions.
> Hira wraps and choreographs specialized Claude Code agents (planner,
> architect, developer, tester, reviewer, …) into a single coherent
> assistant before surfacing the result to the user.

---

## 1. Vision

Claude Code is a powerful single-agent coding session. Real software work,
however, is multi-disciplinary: it requires planning, design, implementation,
testing, review, research, and long-term memory. Today the user has to
context-switch a single Claude Code session through all those modes, and the
session forgets context between runs.

Hira introduces a **higher-level layer** above Claude Code:

- **Plugins** declare *what* the system knows how to do (skills) and
  *who* knows how to do it (agents).
- **Runtime** decides *which* agent should act next, *how* to wire their
  context together, and *what* to return to the user.

Each agent is itself a managed Claude Code session — Hira does not
re-implement the model loop, it composes sessions. This is conceptually
similar to Augment's *Intent* platform: a small number of specialized,
role-driven agents collaborating under an orchestrator, instead of one
monolithic prompt trying to do everything.

---

## 2. Goals & Non-Goals

### Goals
- Compose **multiple specialized Claude Code sessions** behind a single
  user-facing surface.
- Provide a **declarative plugin format** for agents and skills so that
  capabilities can be added without touching the runtime.
- Support **typed, auditable hand-offs** between agents (Planner →
  Architect → Developer → Tester → Reviewer).
- Persist **cross-session memory** (decisions, conventions, glossary,
  past task outcomes) so that work compounds.
- Be **transport-agnostic**: usable from CLI, web, or as a backend for
  other UIs.

### Non-Goals (v1)
- Replacing or forking Claude Code. Hira is a *wrapper*, not a rewrite.
- Training or fine-tuning models.
- Multi-tenant SaaS hosting. v1 targets a single user/workstation or a
  single team's shared instance.
- Realtime collaborative editing (Google-Docs-style co-presence).

---

## 3. Conceptual Model

```
                 ┌────────────────────────────────────────┐
   User ───────► │             Orchestrator               │ ◄── Surface (CLI / web / API)
                 └────────────┬───────────────────────────┘
                              │ dispatch (intent + context)
              ┌───────────────┼───────────────┬──────────────┬──────────────┐
              ▼               ▼               ▼              ▼              ▼
          Planner       Solution        Developer        Tester        Reviewer
                        Architect
              ▲               ▲               ▲              ▲              ▲
              └───────────────┴───────┬───────┴──────────────┴──────────────┘
                                      │ read/write
                              ┌───────┴────────┐
                              │  Knowledge guy │   (codebase / docs / web research)
                              │  Memory keeper │   (long-term store, conventions)
                              └────────────────┘
```

### Key concepts

| Concept       | Description                                                                 |
| ------------- | --------------------------------------------------------------------------- |
| **Agent**     | A role with a system prompt, allowed tools, and a Claude Code session.      |
| **Skill**     | A reusable capability (e.g. "run tests", "search the codebase") that one or more agents can invoke. |
| **Task**      | A unit of work flowing through the runtime; has state, owner agent, parent. |
| **Run**       | One end-to-end execution of an orchestrator turn; produces a transcript.    |
| **Memory**    | Durable, queryable store keyed by project + topic.                          |
| **Hand-off**  | A typed message from one agent to another, with attached artifacts.         |

---

## 4. Architecture

### 4.1 Repository layout

```
hira-agent/
├── plugins/
│   ├── agents/
│   │   ├── orchestrator/        # role definition + system prompt
│   │   ├── planner/
│   │   ├── solution-architect/
│   │   ├── developer/
│   │   ├── tester/
│   │   ├── reviewer/
│   │   ├── knowledge/
│   │   └── memory/
│   └── skills/
│       ├── codebase-search/
│       ├── run-tests/
│       ├── web-research/
│       └── ...
├── packages/                    # pnpm workspace
│   ├── plugin-loader/           # @hira/plugin-loader  (zod-validated manifests)
│   ├── session/                 # @hira/session        (claude CLI subprocess driver, behavioural skills)
│   ├── journal/                 # @hira/journal        (run + handoff + artifact journal, JSONL → SQLite in M1.5)
│   ├── mcp-skills/              # @hira/mcp-skills     (built-in MCP server: memory, handoff, spec-consistency)
│   ├── memory/                  # @hira/memory         (SQLite + vector store)
│   ├── runtime/                 # @hira/runtime        (orchestrator, bus, surface re-exports)
│   └── cli/                     # @hira/cli            (`hira` user-facing CLI)
├── .hira/                       # runtime artefacts (gitignored)
│   ├── runs/<run_id>/           # per-run journals, per-agent settings + mcp configs
│   └── memory/                  # SQLite + vector index
└── examples/                    # sample tasks / fixtures
```

### 4.2 Plugin layer

A **plugin** is a directory with a manifest. Two kinds in v1: `agent` and
`skill`. Manifests are loaded at startup and discoverable at runtime.

```yaml
# plugins/agents/developer/agent.yaml
name: developer
version: 0.1.0
kind: agent
model: claude-opus-4-7        # advisory — subscription plan has final say (§4.7)
prompt: ./system.md           # role-specific system prompt
skills:                       # whitelist of skill names this agent may invoke
  - codebase-search
  - run-tests
  - apply-patch
tools:                        # Claude Code tool allowlist
  - Read
  - Edit
  - Write
  - Bash
inputs:                       # typed contract (JSON schema)
  schema: ./inputs.schema.json
outputs:
  schema: ./outputs.schema.json
escalates_to:                 # who this agent can hand off to
  - reviewer
  - tester
  - solution-architect        # when the design needs to change
budgets:
  max_turns: 40
  max_tokens: 200000
```

```yaml
# plugins/skills/run-tests/skill.yaml
name: run-tests
version: 0.1.0
kind: skill
entrypoint: ./run.sh          # or a shell command template
inputs:
  schema: ./inputs.schema.json
outputs:
  schema: ./outputs.schema.json
```

Skills are **side-effect-aware** — they declare whether they read, write,
or run network calls. The runtime uses this to gate permissions.

### 4.3 Runtime layer

Five sub-systems, kept deliberately small:

1. **Orchestrator** — the only component that talks to the user. Receives
   the user message, classifies intent, opens a `Run`, dispatches to one
   or more agents, collates results, returns a single reply.
2. **Session manager** — owns Claude Code session lifecycle. Spawns
   sessions per agent role, attaches their system prompt + tool
   allowlist, persists their transcripts, reuses warm sessions where safe.
3. **Bus** — typed message-passing between agents. Messages are
   `(from, to, kind, payload, artifacts)`. Synchronous request/response
   by default; supports fan-out for parallel review.
4. **State** — task graph (`Task` nodes, `dependsOn` edges) and a run
   journal. Replayable. Backed by SQLite in v1.
5. **Memory** — the long-term store the Memory Keeper agent reads/writes.
   Hybrid: structured records (decisions, conventions, glossary) + vector
   index over freeform notes. Scoped by `project_id`.

### 4.4 Claude Code CLI as substrate

Each agent invocation is a **spawned `claude` CLI subprocess** running
in headless mode (`-p` / `--print` with `--output-format stream-json`).
We do **not** use the Anthropic API or the Agent SDK directly. This
choice is deliberate (see §4.7 for the trade-offs):

- **Billing.** The host machine is logged in to Claude Code with a
  Pro/Max subscription (`claude login` run once); spawned subprocesses
  inherit that auth via Claude Code's local credential store. All model
  usage is metered against the subscription quota — **no API key, no
  per-token billing**.
- **Tool runtime.** Claude Code already implements Read/Edit/Write/Bash
  /Grep/Glob/WebFetch/WebSearch, the permission system, and MCP tool
  hosting. We re-use all of it instead of re-implementing.

For each hand-off the **Session driver** (`@hira/session`):

1. Materialises the agent's effective system prompt: `system.md`
   contents + injected context (task description, hand-off envelope,
   relevant memory excerpts). Written to a tempfile for `--system-prompt`.
2. Writes a per-session settings file with the manifest's tool allowlist
   pre-approved (`.hira/runs/<run_id>/<agent>/settings.json`), so
   headless runs do not block on permission prompts.
3. Generates the per-agent MCP config (see §4.6) listing the Hira
   skills this agent may call.
4. Spawns `claude` with the flags assembled (see *Invocation contract*
   below), captures `--output-format stream-json` events on stdout.
5. Persists the full event stream to the run journal and extracts the
   structured response (a fenced JSON block in the final assistant
   message, validated against the agent's `outputs.schema`).

**Invocation contract** (one hand-off → one subprocess):

```
claude -p "<envelope serialised as a message>" \
  --system-prompt "<rendered system prompt>" \
  --allowedTools  "<from manifest.tools, comma-joined>" \
  --disallowedTools "<global denylist>" \
  --permission-mode acceptEdits \
  --max-turns <budgets.max_turns> \
  --output-format stream-json \
  --verbose \
  --mcp-config .hira/runs/<run_id>/<agent>/mcp.json \
  --cwd <project root or scoped path>
```

For warm hand-offs (§4.5) the first call captures the `session_id` from
the initial `system` event; subsequent calls pass `--resume <id>`
instead of `--system-prompt` (Claude Code already has the prompt
loaded).

**Hira owns coordination; Claude Code owns the model loop and the
tools.** The session driver is the only place in Hira that knows the
substrate is a CLI subprocess — every other component sees agents as
pure `(envelope in) → (envelope out)` functions.

### 4.5 Session lifecycle: fresh per hand-off (default), warm opt-in

**Default: fresh Claude Code session for every hand-off.** Each session
starts from `(system prompt + injected context + hand-off envelope)`
and dies when the hand-off completes.

| | Fresh per hand-off (chosen default) | Warm per agent within a Run |
| --- | --- | --- |
| **Replayability** | Pure: same inputs → same behavior. Trivial to replay a Run from the journal. | Output depends on hidden session history — harder to reproduce. |
| **Context hygiene** | No pollution; budget is bounded per hand-off. | Earlier turns drag along whether relevant or not; long Runs blow the window. |
| **Hand-off contract** | Everything the agent knows arrived in the typed envelope or memory — contracts stay honest. | Agents "know" things outside the envelope; contracts leak. |
| **Parallel fan-off** | Trivial — spawn N Reviewers in parallel. | One session, one consumer. |
| **Audit trail** | Each transcript is self-contained. | Transcripts braid across hand-offs. |
| **Latency** | Cold start each time. | Warm; no re-read. |
| **Cost** | Re-sends system prompt each call. | Saves the re-send. |
| **Continuity** | Memory store is the only continuity mechanism. | Agent has working memory across the Run for free. |

**How the modes map to the CLI driver:**

- **Fresh** = a new `claude -p ...` subprocess per hand-off, with
  `--system-prompt` rendered from scratch. The cost we pay is repeated
  prompt processing; Claude Code's own prompt caching reclaims most of
  it on cache-eligible content.
- **Warm** = the first hand-off captures the `session_id` emitted in
  the CLI's `system` init event; subsequent hand-offs within the same
  Run skip `--system-prompt` and pass `--resume <session_id>` to
  Claude Code, which restores the conversation in-place.

**Per-agent opt-in for warm sessions within a Run** is set in the
manifest (`session.mode: warm | fresh`, default `fresh`). The natural
candidates are agents that iterate with a partner — typically Developer
↔ Reviewer cycles — where continuity is worth the trade-off. Warm
sessions never survive past Run boundaries; the run finaliser deletes
the captured session IDs.

### 4.6 Skill plugins exposed via MCP

Hira skills that the model itself must be able to invoke (e.g.
`memory.query`, `handoff.escalate`, `journal.note`) are exposed to the
agent as **MCP tools**. The Session driver generates a per-agent MCP
config (`.hira/runs/<run_id>/<agent>/mcp.json`) listing only the
skills permitted by that agent's manifest, then passes it via
`--mcp-config`.

Hira ships one built-in MCP server (`@hira/mcp-skills`) that hosts the
core skills. Third-party skills can be added by dropping a manifest in
`plugins/skills/<name>/skill.yaml` pointing at any MCP-compatible
binary; Hira does not care what language it's written in.

Skills that do **not** need to be model-callable (e.g. "run the test
suite" invoked by Hira *after* an agent's hand-off) stay outside MCP
and are executed directly by the runtime.

### 4.7 Quotas, parallelism, and degraded modes

CLI-subprocess substrate is cheaper but **rate-limited by the
subscription plan**, not metered by tokens. Implications the runtime
must respect:

- **Single Anthropic identity per host.** Claude Code's auth lives in
  one credential store on disk; we cannot fan out across multiple
  accounts to multiply throughput.
- **Subscription rate windows (5-hour, weekly).** The orchestrator
  must surface CLI rate-limit errors as first-class events, back off,
  and (for long Runs) check remaining budget before fanning out.
- **Parallel hand-offs share the same quota.** Spawning N Reviewers in
  parallel is fine technically (each is its own subprocess), but each
  burns the same pool — fan-out is a cost dial, not free.
- **Degraded mode.** When the rate window is exhausted, the runtime
  pauses non-essential agents (Memory Maintainer, parallel Reviewer
  fan-out) before pausing the critical path. The user can opt back into
  API-key mode per Run with `hira run --api-key` if they have an
  `ANTHROPIC_API_KEY` and want to bypass quota at metered cost — kept
  as an explicit opt-in, not the default.
- **Model selection.** Claude Code picks the model per its subscription
  rules; `manifest.model` becomes an *advisory* hint passed via
  `--model` and silently ignored if the plan does not allow it. We
  no longer assume free per-agent model choice.

### 4.8 Spec lifecycle: deltas, consistency, and verification gates

The runtime treats the spec/ADR store as a **first-class state machine**
rather than an artifact written as a side effect of a Run. Three pieces:

**Delta state machine.** Specs and ADRs live in two states: `baseline`
(verified, merged) and `delta` (proposed by a Run, not yet integrated).
A Run produces deltas in `.hira/runs/<run_id>/deltas/`; they fold into
the baseline only after the verification gates below pass and the user
approves the Run. Failed Runs leave the baseline untouched. The Memory
Maintainer's writes (§5.8) operate on the baseline, never on deltas.

**Cross-Artifact Consistency pass.** Before the Orchestrator dispatches
a task graph to the Developer, a read-only consistency check runs over
(Planner task graph + Architect ADR + baseline memory) and reports:
- duplications against existing specs/ADRs,
- ambiguities (vague acceptance criteria, untestable requirements),
- coverage gaps (intent items with no task, tasks with no acceptance
  criterion),
- conflicts with prior decisions in memory.

Failures block dispatch and surface to the user for revision. Implemented
as a `spec-consistency` skill (MCP-callable, so Planner and Architect can
also self-check) rather than a separate agent.

**Verification Engine.** The Reviewer in §5.6 is split into two stages:
1. **Deterministic Verification Engine** (runtime-owned, *not* an agent).
   Runs after every Developer hand-off: project test suite, type checker,
   linter, optional Semgrep, optional contract checks (Schemathesis /
   OpenAPI). Outputs structured results. **The hand-off is gated on this
   stage.** Tool selection is per-project config; the engine is a thin
   harness, not a re-implementation.
2. **Model Reviewer** (the existing §5.6 agent). Runs only after the
   deterministic stage passes. Judges what tools cannot — correctness
   against intent, style, security nuance, scope creep.

Deterministic failures route straight back to Developer with the tool
output attached. The two-rejections → Architect arbitration flow in §5.6
applies to the **model Reviewer stage only**.

### 4.9 Bidirectional traceability

The run journal already records the full chain (intent → Planner task →
ADR → Developer patch → Verification Engine results → Reviewer verdict).
Exposing it bidirectionally is a surfacing concern, not a storage one: a
new CLI view (§8.2) lets the user walk forward from any requirement to
its consequences (tasks, patches, tests) and backward from any patch or
test failure to the requirement that produced it. Same data, queryable
from either end.

### 4.10 Run lifecycle

What `hira run "<goal>"` actually does today, end to end. Every step is
recorded in the journal (`.hira/runs/<run_id>/journal.jsonl`), live
progress events stream as the agents run, and the chain is walkable via
`hira runs trace`.

```
$ hira run "<goal>"

  1. user → orchestrator   [classify]
       Emits a fenced JSON decision:
         {action: "reply",    message}                      → skip to 6
         {action: "dispatch", target: "planner", payload}

  2. orchestrator → planner [decompose]
       Returns a task graph. May self-call spec_consistency_check
       (mounted via MCP — §4.6).

  3. memory query
       Baseline memory records (§5.8) relevant to the intent are
       injected as memory_context[] into every downstream task payload.

  4. Executor walks the task graph in dependency order:

       a. knowledge / solution-architect
            Read-only specialists, cwd = project root.
            Architect may also self-call spec_consistency_check.

       b. Cross-Artifact Consistency gate (§4.8)
            Runs once, before the first Developer task. A `blocked`
            report halts dispatch — Developer + downstream skipped.

       c. developer
            Real Edit/Write/Bash, scoped to a fresh git worktree at
            .hira/runs/<run_id>/worktree/ on a branch hira/run-<short>.

       d. deterministic Verification Engine (§4.8)
            Runs the project's hira.config.json checks against the
            worktree. `fail` → Developer re-runs once with the
            verification_failure attached. Still failing → hard gate,
            downstream skipped.

       e. tester / reviewer
            Read-only, cwd = worktree, so they see the actual diff.
            Reviewer sees the verification report on its input.

  5. memory maintainer
       Reads the chain, proposes ADR / outcome records — staged as a
       delta in .hira/runs/<run_id>/deltas/memory.json. Baseline
       memory is NOT modified yet (§4.8 delta state machine).

  6. user → orchestrator   [synthesise]
       Composes the user-facing reply summarising what was decided,
       what the verification gate said, the worktree branch (if any),
       and the staged memory delta.

  7. finalize
       Worktree changes are committed to branch hira/run-<short>;
       the worktree directory is removed (the branch persists for
       inspection). The Run closes status=succeeded, approval=pending.

  8. user decides
       `hira runs approve <run_id>` folds the memory delta into
       baseline memory and reports the worktree branch for manual
       merge. `hira runs reject` discards the delta and deletes the
       branch. Decisions are immutable.

A direct-reply Run stops at step 1; an unapproved Run stops at step 7
with the deltas on disk but the baseline untouched. A crashed Run
(`status: running` with no `run_closed`) can be re-entered via
`hira runs resume <run_id>` — see §14 for what that reuses.
```

---

## 5. Agent Catalog (v1)

Each agent definition below is the minimum the runtime needs to spawn it.
Full system prompts live in `plugins/agents/<name>/system.md`.

### 5.1 Orchestrator
- **Role:** Front door. Talks to the user. Classifies the request, routes
  to the right agent(s), composes the final reply.
- **Inputs:** user message, conversation history, project state.
- **Outputs:** user-facing reply + a `Run` record.
- **Skills:** intent classification, plan dispatch.
- **Notes:** The only agent the user sees. Never writes code itself —
  always delegates.

### 5.2 Planner
- **Role:** Decompose a goal into an ordered task list with explicit
  owners (which agent does each step).
- **Inputs:** goal, constraints, current codebase summary.
- **Outputs:** task graph (nodes + dependencies + suggested owner).
- **Escalates to:** Solution Architect (when the plan exposes a design
  question), Knowledge (when missing facts block planning).

### 5.3 Solution Architect
- **Role:** Make non-local technical decisions — module boundaries, data
  model, API shape, trade-offs.
- **Inputs:** problem statement, relevant memory (past decisions,
  conventions), codebase facts from Knowledge.
- **Outputs:** Architecture Decision Record (ADR) — context, options,
  decision, consequences. Written to memory.

### 5.4 Developer
- **Role:** Implement a single, well-scoped task. One ADR + one task in,
  one diff out.
- **Inputs:** task spec, ADR, code context.
- **Outputs:** patch (unified diff), changed files list, brief notes.
- **Tools:** Read, Edit, Write, Bash (scoped).
- **Escalates to:** Solution Architect (if the task forces a design
  change), Knowledge (if facts are missing).

### 5.5 Tester
- **Role:** Write tests for new behavior and run the suite. Reports
  failures with diagnosis.
- **Inputs:** patch from Developer, task spec.
- **Outputs:** added/changed test files, test run report (pass/fail +
  failure analysis).
- **Tools:** Read, Edit, Write, Bash (test commands only).

### 5.6 Reviewer
- **Role:** Code review — correctness, style, security, scope creep.
- **Stage:** Runs as the **second** verification stage. The deterministic
  Verification Engine (§4.8) gates the Developer hand-off first; the
  Reviewer only sees patches that already pass tests, types, lint, and
  any configured static-analysis tools.
- **Inputs:** patch, task spec, ADR, Verification Engine report.
- **Outputs:** review comments (severity-tagged), overall verdict
  (`approve` / `request-changes`).
- **Read-only** tool set; cannot edit files.
- **Conflict resolution:** if the Reviewer rejects Developer's patch
  **twice on the same task**, the dispute is escalated to the **Solution
  Architect**, who reviews the ADR, Developer's patches, and Reviewer's
  comments and produces an arbitration verdict (`adjust-adr`,
  `side-with-reviewer`, `side-with-developer`, or `re-scope`). The
  Architect's verdict is **not auto-applied** — the Orchestrator
  surfaces it to the user for approval before any further action. The
  user's call is then recorded to memory as a precedent.

### 5.7 Knowledge ("knowledge guy")
- **Role:** Answer factual questions about the codebase, the docs, the
  ecosystem, or the web. Fast, read-only.
- **Inputs:** a question + scope hints.
- **Outputs:** concise answer with citations (file:line, URL).
- **Tools:** Read, Grep/Glob, WebFetch, WebSearch.

### 5.8 Memory Maintainer
- **Role:** Decide what is worth remembering from a Run and write it to
  the memory store. Also serves memory queries from other agents.
- **Inputs:** completed Run transcript + artifacts.
- **Outputs:** memory records (decisions, conventions, glossary entries,
  task outcomes), with TTL / freshness metadata.
- **Constraints:** can write only to `memory/`; cannot modify code.

---

## 6. Hand-off Protocol

Every inter-agent message is a typed envelope:

```ts
type Handoff = {
  run_id: string;
  from: AgentName;
  to: AgentName;
  kind: "request" | "response" | "escalation" | "review";
  task_id: string;
  payload: unknown;             // validated against the target's input schema
  artifacts: Artifact[];        // patches, ADRs, test reports, citations
  parent_handoff_id?: string;
};
```

Rules:
- Agents may only hand off to targets listed in their manifest's
  `escalates_to`.
- The orchestrator can broker any pair.
- Hand-offs are persisted to the run journal — every Run is fully
  replayable.

**Wire format on the CLI boundary.** The envelope is serialised to
JSON and passed as the prompt (`claude -p '<json>'`) wrapped in a
short framing message ("You are handling hand-off X from Y. Envelope
follows."). The agent's reply must end with a fenced ```json``` block
matching its `outputs.schema`; the session driver extracts and
validates it before lifting it back into a `Handoff` object. Anything
the agent writes outside that block is treated as freeform reasoning
and stored in the journal but ignored by the bus.

---

## 7. Worked Example: "Add a rate limiter to the login endpoint"

1. **User → Orchestrator.** "Add a rate limiter to login."
2. **Orchestrator → Planner.** Planner returns a 4-step task graph:
   research current auth → design limiter → implement → test+review.
3. **Planner → Knowledge.** Knowledge reports: `auth/login.py:42`,
   uses Flask, no existing limiter, Redis is available.
4. **Planner → Solution Architect.** Architect writes ADR-007:
   "Token-bucket per-IP, 5 req/min, Redis-backed, fail-open on Redis
   outage." Stored in memory.
5. **Orchestrator → Developer** with ADR-007 + task. Developer produces a
   patch.
6. **Developer → Tester.** Tester adds `test_login_rate_limit.py`, runs
   the suite, reports green.
7. **Tester → Reviewer.** Reviewer flags one concern (no logging on
   rejection). Developer iterates once.
8. **Memory Maintainer** records: ADR-007 (decision), `rate-limit` →
   `auth/limits.py` (glossary entry), task outcome.
9. **Orchestrator → User.** "Done. Added a Redis-backed token-bucket
   limiter at `auth/limits.py`. ADR-007 recorded. Tests pass."

Only step 9 is user-visible. The runtime produced one coherent answer
from seven agent turns.

---

## 8. Runtime APIs

### 8.1 Programmatic (Python or TypeScript SDK, TBD)

```python
hira = Hira(project="my-app")
result = hira.run("Add a rate limiter to login")
print(result.reply)            # final user-facing message
print(result.run_id)           # for inspection / replay
```

### 8.2 CLI

```
hira run "Add a rate limiter to login"
hira runs list
hira runs show <run_id>        # full transcript + hand-off tree
hira runs trace <run_id>       # bidirectional view: req ↔ task ↔ ADR ↔ patch ↔ tests (§4.9)
hira runs trace <artifact_id>  # walk from any artifact in either direction
hira memory query "rate limit"
hira agents list
hira plugins reload
```

### 8.3 HTTP (optional, behind a flag)

`POST /runs` `{ message }` → `{ run_id, reply, transcript_url }`

---

## 9. Configuration

`runtime/config/hira.yaml` (per project):

```yaml
project: my-app
claude:
  binary: claude              # path to the Claude Code CLI
  permission_mode: acceptEdits
  output_format: stream-json
  # default_model is advisory; subscription plan has the final say (§4.7)
  default_model: claude-opus-4-7
agents:
  knowledge:
    model: claude-haiku-4-5-20251001   # advisory
budgets:
  per_run:
    max_handoffs: 30
    max_wall_clock_s: 600
rate_limits:
  on_exhaustion: pause-noncritical    # | fail-fast | switch-to-api-key
memory:
  backend: sqlite+vector
  path: .hira/memory
runs:
  journal_path: .hira/runs
```

---

## 10. Tech Stack

- **Language:** **TypeScript** (decided). Matches the Claude Code
  ecosystem, keeps plugin manifests / runtime contracts in one type
  system. Plugins (skills) are language-agnostic — they shell out or
  expose MCP servers.
- **Session driver:** spawned **Claude Code CLI** subprocesses
  (`claude -p --output-format stream-json --verbose`), authed via the
  host's Pro/Max login (§4.4). Communicate via stdin/stdout JSON-line
  streams; managed by `@hira/session` using `node:child_process`.
- **Skill runtime:** model-callable skills are exposed as **MCP
  servers**; built-ins ship in `@hira/mcp-skills`. Non-model skills
  are plain processes the runtime invokes between hand-offs.
- **State:** SQLite via `better-sqlite3` for task graph + run journal.
- **Memory:** SQLite for structured records + a local vector index
  (`sqlite-vec` first; Chroma if we need more) for freeform notes.
- **Transport:** Local CLI first; HTTP server behind a flag.
- **Schemas:** JSON Schema for plugin input/output contracts, Zod at the
  TypeScript boundary, schemas compiled to both at build time.
- **Runtime layout:** monorepo with pnpm workspaces — `@hira/runtime`,
  `@hira/cli`, `@hira/plugin-loader`, `@hira/session`, `@hira/memory`,
  `@hira/mcp-skills`.

### Prerequisites on the host
- Claude Code CLI installed and on `PATH` (`claude --version` must work).
- `claude login` completed once with a Pro or Max subscription.
- Node 20+ (already required for the runtime).

### Installing the CLI
- `pnpm install && pnpm -r build` from the repo root.
- One-time `pnpm setup` to initialise `PNPM_HOME`, then
  `pnpm --filter @hira/cli link --global` to put `hira` on `$PATH`.
- Plain `ln -s "$PWD/packages/cli/dist/index.js" ~/.local/bin/hira` or
  a shell alias also work — the CLI is built as a single
  self-contained ESM file.
- See [`README.md`](./README.md) for the full walkthrough including
  the `--plugins-root` / `--project` separation that lets `hira` work
  from any cwd.

---

## 11. Milestones

| Milestone | Scope |
| --------- | ----- |
| **M0.1 — Skeleton** ✅ | pnpm/TS workspace, plugin loader (zod-validated), eight agent manifests with placeholder prompts, `hira agents list`. *(Landed in `1b9c4a2`.)* |
| **M0.2 — Session driver** ✅ | `@hira/session` spawns a single `claude -p` subprocess (Orchestrator role), captures stream-json events, returns the assistant reply. `hira run "<msg>"` works end-to-end against the Pro subscription. `--dry-run` prints the assembled invocation. *(Landed in `367fd06`.)* |
| **M0.3 — Agent isolation** ✅ | Per-agent isolation directory at `.hira/runs/<run_id>/<agent>/`, generated `settings.json` with empty `hooks` + tool allowlist as `permissions.allow`, `--setting-sources ""` to suppress host `~/.claude` and project `.claude/` inheritance. Verified the stop-hook contamination from §12-#16 is gone on the dev sandbox; added an opt-in e2e test (`HIRA_E2E=1`). |
| **M1.1 — Foundations** ✅ | `@hira/journal` (JSONL backend, stable artifact IDs `kind:run_id_short:seq` per §4.9), typed `Handoff` zod schema with forward-compat `verification_report` + `delta_refs` fields, behavioural-skill resolver in `@hira/session` (loads SKILL.md, strips frontmatter, prepends to system prompt), journal-aware `hira run` writing one (user → orchestrator) hand-off per Run, `hira runs list`, `hira runs show <run_id>`. Karpathy guidelines verified inlined into Developer's effective prompt. |
| **M1.2 — First hand-off** ✅ | `Bus.dispatch(envelope)` primitive in `@hira/runtime` (escalation check, isolation prep, journal start/complete, fenced-JSON extraction). Orchestrator now classifies intent via fenced `{"action":"reply"\|"dispatch", …}`; Planner produces a typed task graph (`tasks[]` with `id`/`description`/`owner`/`depends_on` + `rationale`). `hira run` flow: user → orchestrator → (planner if dispatched), with `parent_handoff_id` linking. Verified end-to-end: direct reply ("56") and dispatched plan (5 owners) both clean. |
| **M1.3.a — Executor, verification seam, synthesis** ✅ | `Executor` walks the Planner's task graph in topological order, dispatches each task to its owner via the bus, surfaces a `parent_handoff_id`-linked tree. Verification Engine seam (`verifyDeveloperHandoff`) records a `skipped` artifact after every Developer hand-off (M1.5 fills it in). Bus accepts an optional `tools` override so specialist invocations stay read-only this milestone. Real system prompts for Knowledge (read-only researcher) and Solution Architect (ADR producer). Orchestrator's second turn synthesises the chain into a user-facing summary. End-to-end verified: Knowledge agent autonomously scanned the codebase, discovered it's a TS monorepo (not Flask), Architect adapted the ADR to the real stack, synthesis composed a clear plain-text summary. |
| **M1.3.b — Developer / Tester / Reviewer prompts** ✅ | All three specialists wired with structured-output system prompts in dry mode: Developer emits `{summary, changed_files, patch, notes, open_questions}`, Tester emits `{added_tests[], test_command, result:"skipped", details, concerns}`, Reviewer emits `{verdict, summary, comments[]}`. `WIRED_OWNERS` now covers all five. Verified end-to-end on a real 7-hand-off Run (`hira version` subcommand proposal): every handoff produced a well-formed structured artifact, the deterministic-Verification-Engine seam fired and recorded an artifact against the Developer hand-off (Reviewer hit the 10-min sandbox timeout but the architecture is validated). Edit / Write / Bash remain masked by the executor's `toolsOverride`; real file mutation lifts in M1.5. |
| **M1.5.a — Verification Engine harness** ✅ | Deterministic, runtime-owned engine: per-project `hira.config.json` `verification.checks[]` (name + shell command + optional timeout), command runner with timeout + output capture, structured `VerificationReport`. Wired into the executor's verification seam (replaces the M1.3 no-op); the report is journaled as a `verification` artifact on the Developer hand-off and flows into the Reviewer's input as `dependencies[].verification`. No config → `skipped` report (no auto-detection magic). Developer stays dry-mode this slice — the engine verifies baseline health; the report is informational, not yet a hard gate. |
| **M1.5.b — Real Developer edits + hard gate** ✅ | Per-Run git worktree (`@hira/runtime/worktree.ts`) at `.hira/runs/<run_id>/worktree/` on a throwaway `hira/run-<short>` branch. The Developer runs there with real `Edit/Write/Bash`; Tester/Reviewer read there; Knowledge/Architect stay on the project root. Bus gained a per-dispatch `cwd` override; the Executor routes cwd + tools per owner. The Verification Engine verifies the worktree (the actual diff). A failing report routes the task **back to the Developer once** with the `verification_failure` payload attached; still failing → `gate_failed`, downstream tasks skipped. On finalize the worktree is committed to its branch and the directory removed. Non-git projects degrade to read-only dry mode. |
| **M1.5.c-1 — Traceability view** ✅ | `buildRunTrace` re-projects the journal into a `RunTrace` (Planner task graph annotated with each task's hand-off, status, retry count, and artifacts; framing hand-offs separated out). `traceArtifact` walks a DAG: backward from an artifact to the requirements that produced it, forward to the tasks that consumed it. `hira runs trace <run_id>` renders the task chain; `hira runs trace <artifact_id>` renders the bidirectional walk (§4.9). |
| **M1.5.c-2 — Spec/ADR delta state machine** ✅ | The Memory Maintainer no longer auto-writes baseline. Its proposed records (ADRs + outcomes) are staged as a *delta* in `.hira/runs/<run_id>/deltas/memory.json` (`@hira/runtime/delta.ts`). `hira runs approve <run_id>` folds the delta into the baseline memory store and records the decision in the journal; `hira runs reject` records rejection and deletes the Run's worktree branch. Decisions are immutable. The journal carries an `approval` field per Run, surfaced in `runs list` / `runs show`. Code-as-delta stays the worktree branch from M1.5.b — `approve` reports it for `git merge` rather than auto-merging. Failed/unapproved Runs leave the baseline untouched (§4.8). |
| **M1.5.c-3 — spec-consistency check + first MCP server** ✅ | `checkConsistency` (`@hira/runtime/consistency.ts`) — deterministic Cross-Artifact Consistency check (SPEC §4.8): structural blockers (no tasks, empty description, unknown owner, dangling dependency, cycle) + memory-overlap warnings. The Executor runs it as a gate before the first Developer task; a `blocked` report halts dispatch and skips the Developer + downstream. `@hira/mcp-skills` — the project's first MCP server (`@modelcontextprotocol/sdk`), exposing `spec_consistency_check` as a model-callable tool over stdio. *(Agent-side auto-call landed in the MCP auto-call slice below.)* |
| **MCP auto-call** ✅ | Agents can now self-call MCP skills. `skill.yaml` gained an `mcp: { tool }` block — a skill with it is an MCP skill, one with a `SKILL.md` is behavioural (mutually exclusive). The Bus, for an agent whose allowlist includes an MCP skill, writes a per-agent `mcp.json`, mounts Hira's `hira-skills` server via `--mcp-config`, and adds `mcp__hira-skills__<tool>` to the allowlist. Planner and Solution Architect now list `spec-consistency` and self-check before handing off. Verified end-to-end: the Planner invoked `spec_consistency_check` mid-Run. |
| **M1.4 — Resume** ✅ | `hira runs resume <run_id>` recovers an interrupted (`running` / `failed`, not yet decided) Run from the journal. It reconstructs the plan from the original Planner hand-off and reuses completed self-contained task results — Knowledge and Architect (`RESUMABLE_OWNERS`) — via the Executor's `priorResults` map, so the expensive research/design phase is not re-paid. Developer / Tester / Reviewer always re-run fresh (their worktree state is lost on a crash). `createRunWorktree` is idempotent — it cleans up a stale worktree/branch first. The post-plan pipeline (`runPipeline`) is shared by `hira run` and `hira runs resume`. |
| **M1.4+ — Live progress streaming** ✅ | The Session driver takes an `onEvent` callback; the Bus streams each parsed stream-json event into the journal as a compact `handoff_progress` entry (`started` / `tool` / `message`). A hand-off that never completes (a crash) now shows how far the agent got — `hira runs show` prints the progress trail for `in_progress` hand-offs. The journal serialises all appends through a write queue so fire-and-forget progress events cannot interleave with the awaited `completeHandoff`. |
| **M2.a — Memory loop** ✅ | `@hira/memory` real implementation: zod-validated `MemoryRecord` (kind: adr/outcome/convention/glossary, tags, source.run_id), JSONL backend at `.hira/memory/records.jsonl`, keyword-search ranking with tag×3/title×2/body×1 weights. Runtime queries memory before the executor and injects `memory_context[]` into every task payload; Knowledge agent's prompt now cites `memory:<id>`. Memory Maintainer runs after the executor, emits `{records[]}` for the runtime to persist. New CLI: `hira memory list/show/query`. Decision on §12 #11 (memory granularity): automatic for ADRs + notable outcomes via the Maintainer's judgement; conventions and glossary entries stay manual until M2.b. |
| **M2.b — Manual memory + scale switch** | `hira memory write` for explicit "remember this"; promote storage to SQLite + FTS5 (and later vector index) when JSONL recall degrades or volume crosses ~500 records. |
| **M3 — Robust hand-offs** | Schema validation enforced both ways, journal replay command, budgets + rate-limit handling (§4.7), failure modes (timeout, malformed JSON reply, missing `claude` binary). |
| **M4 — Surfaces**     | HTTP API, web UI shell, GitHub PR comment surface. |
| **M5 — Polish**       | Quota dashboards, parallel review fan-out with quota-aware throttling, MCP-based plugin marketplace format. |

---

## 12. Decisions & Open Questions

### Decided
1. **Runtime language: TypeScript** (§10).
2. **Session lifecycle: fresh per hand-off by default**, warm-within-Run
   opt-in per agent manifest (§4.5).
3. **Conflict resolution: Solution Architect arbitrates after two
   Reviewer rejections, then the verdict goes to the user for approval**
   (§5.6).
4. **Substrate: spawned Claude Code CLI subprocesses** (not the
   Anthropic SDK), authed via Pro/Max subscription, billed against the
   subscription quota (§4.4, §4.7).
5. **Permission model: pre-approve the manifest's tool allowlist** in a
   per-session settings file at run-start; headless invocations never
   prompt. The global denylist (e.g. destructive Bash) is enforced by
   the runtime, not the agent.
6. **Skills are MCP servers** when the model must invoke them;
   between-hand-off skills (e.g. test suite) stay outside MCP (§4.6).
7. **Spec/ADR delta state machine** with explicit pre-merge gates;
   Runs produce deltas, baseline only changes on user approval (§4.8).
8. **Cross-Artifact Consistency pass** runs between planning and
   Developer dispatch, implemented as a `spec-consistency` skill, not a
   new agent (§4.8).
9. **Two-stage verification:** a deterministic, runtime-owned
   Verification Engine gates the Developer→Reviewer hand-off; the model
   Reviewer is the second stage and only judges what tools cannot
   (§4.8, §5.6).
10. **Bidirectional traceability** is a surfacing concern over the
    existing journal, exposed via `hira runs trace` (§4.9).

### Still open
11. ~~**Memory granularity**~~ — **resolved in M2.a.** Memory Maintainer
    runs automatically after every successful executor pass and decides
    what to keep (model judgement). Defaults: ADRs from the architect
    always, notable outcomes when there's a real lesson. Conventions
    and glossary entries stay manual (M2.b adds `hira memory write`).
12. **`--resume` durability** — does Claude Code guarantee a captured
    `session_id` is resumable later in the same Run, or do we need to
    pin a CLI version? Validate before relying on warm mode in M1.
13. **Concurrency vs quota** — should fan-out (parallel Reviewers) be
    gated by a runtime semaphore, or do we let it rip and react to
    rate-limit errors? Decide once we observe real quota behaviour.
14. ~~**Verification Engine tool defaults**~~ — **resolved in M1.5.a.**
    No defaults and no auto-detection: the engine runs exactly the
    checks declared in `<project>/hira.config.json` `verification.checks[]`
    (each a `{name, command, timeout_ms?}`). Absent or empty config →
    the engine reports `skipped` with a message telling the user to add
    one. Auto-detection (e.g. infer `npm test` from `package.json`) and
    heavier tools (Semgrep / Schemathesis) can be layered on later but
    are deliberately not magic in v1.
15. ~~**Spec-consistency severity policy**~~ — **resolved in M1.5.c-3.**
    Structural defects (no tasks, empty description, unknown owner,
    dangling dependency, cycle) are `blocker` and halt dispatch.
    A new ADR overlapping a prior baseline decision is a `warning` —
    surfaced, never blocking. Ambiguity detection is deliberately out
    of scope: it needs model judgement, not a deterministic rule, so
    it is left to the Planner's and Architect's own reasoning.
16. ~~**Agent isolation from host Claude Code config**~~ — **resolved in
    M0.3.** Default `SessionInvocation.settingSources = []` plus a
    Hira-generated per-agent `settings.json` (empty `hooks`, allowlist
    mirrored into `permissions.allow`) drops the host's hooks, project
    `.claude/`, and inherited permissions. CLAUDE.md auto-discovery from
    the agent's `--cwd` is **not** suppressed by this — fine for the
    Orchestrator (no tools, no file reads) but revisit when agents
    operate with `--cwd <project root>` and a stale CLAUDE.md could
    inject noise. Likely needs an opt-in `--add-dir` + scoped cwd
    pattern in M1.

---

## 13. Out of Scope (explicitly)

- Visual workflow editor.
- Non-Claude model backends.
- Fine-tuning or RLHF loops on past runs.
- Auto-merging PRs without human approval.

---

## 14. Limitations (current behaviour)

What Hira does today, but with caveats a user should know. Each
limitation links to where it gets addressed (or to the open question
that defers it).

- **Resume can't continue a mid-Developer crash.** `hira runs resume`
  reuses completed Knowledge / Architect results, but Developer-onward
  re-runs fresh. Continuing the Developer's *session* would require
  dropping `--no-session-persistence` and validating `--resume`
  durability (§12 #12).

- **Non-git projects degrade to read-only mode.** The Developer's
  worktree-based real-edit path (§4.8 / M1.5.b) requires `git`. In a
  non-git project the Developer stays dry-mode and the engine verifies
  the baseline rather than a diff.

- **CLAUDE.md auto-discovery from `--cwd` is not suppressed.** Agent
  isolation suppresses inherited settings / hooks / permissions
  (`--setting-sources ""`), but Claude Code still discovers any
  `CLAUDE.md` rooted at the agent's working directory. Fine in
  practice — Orchestrator has no tools, worktree agents work on a
  clean tree — but worth knowing if a project drops a CLAUDE.md that
  would mislead an agent.

- **Single Anthropic identity per host.** `claude login` lives in one
  place on disk; Hira cannot fan out across multiple accounts to
  multiply throughput.

- **Subscription rate windows are not handled.** A long Run that
  exhausts the Pro/Max 5-hour window will fail mid-stream; budget +
  back-off + `switch-to-api-key` opt-in are M3 work (§4.7).

- **Per-Run budgets are advisory only.** `manifest.budgets.max_turns`
  and `max_tokens` are not enforced; a runaway agent runs until the
  per-check timeout or external kill. Hard budget enforcement is M3.

- **JSONL memory store ceiling.** Recall is keyword-only (weighted
  tag / title / body) and load is O(records); fine to ~500 records or
  ~100 ms query latency, then SQLite + FTS5 / vector index in M2.b.

- **No ambiguity detection in the Consistency check.** The MCP skill
  catches structural defects (unknown owner, dangling dep, cycle,
  empty description) and ADR overlap; "vague acceptance criteria" is
  judgement-heavy and deliberately left to the agents' own reasoning
  (§12 #15 closed with this rationale).

- **`hira runs approve` does not auto-merge code.** It folds memory
  deltas into baseline and reports the worktree branch
  (`hira/run-<short>`) for inspection; the user runs `git merge`
  themselves. A `--merge` flag is deliberate-future-work.

- **No schema validation on agent fenced-JSON outputs.** Each agent's
  output shape is declared in its system prompt; the runtime parses
  tolerantly (returns `null` on malformed and surfaces a warning).
  Validation against the agent manifest's `outputs.schema` is M3.

- **CLI only.** No HTTP API, no web UI, no GitHub PR surface — M4.

- **Concurrency is unrestricted in principle, untested in practice.**
  The Executor is sequential today; parallel fan-out (e.g. two
  Reviewers) at the same depth would share the same subscription pool
  with no semaphore. §12 #13 defers the decision until real quota
  behaviour is observed.
