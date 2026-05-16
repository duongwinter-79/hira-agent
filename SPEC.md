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
│   ├── session/                 # @hira/session        (claude CLI subprocess driver)
│   ├── mcp-skills/              # @hira/mcp-skills     (built-in MCP server: memory, handoff, journal)
│   ├── memory/                  # @hira/memory         (SQLite + vector store)
│   ├── runtime/                 # @hira/runtime        (orchestrator, bus, state, run journal)
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
- **Inputs:** patch, task spec, ADR.
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

---

## 11. Milestones

| Milestone | Scope |
| --------- | ----- |
| **M0.1 — Skeleton** ✅ | pnpm/TS workspace, plugin loader (zod-validated), eight agent manifests with placeholder prompts, `hira agents list`. *(Landed in `1b9c4a2`.)* |
| **M0.2 — Session driver** | `@hira/session` spawns a single `claude -p` subprocess (Orchestrator role), captures stream-json events, parses the fenced JSON reply. `hira run "<msg>"` works end-to-end against the Pro subscription. `--dry-run` prints the assembled invocation without spawning. |
| **M1 — Single track** | Orchestrator → Planner → Developer → Tester → Reviewer working on a real task, with the typed Handoff envelope and the SQLite run journal. No memory yet. |
| **M2 — Memory**       | Memory Maintainer wired up; ADRs and glossary written and queryable; Knowledge agent reads from memory. |
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

### Still open
7. **Memory granularity** — what gets remembered automatically vs what
   requires an explicit "remember this" from the user?
8. **`--resume` durability** — does Claude Code guarantee a captured
   `session_id` is resumable later in the same Run, or do we need to
   pin a CLI version? Validate before relying on warm mode in M1.
9. **Concurrency vs quota** — should fan-out (parallel Reviewers) be
   gated by a runtime semaphore, or do we let it rip and react to
   rate-limit errors? Decide once we observe real quota behaviour.
10. **Agent isolation from host Claude Code config** — observed in M0.2
    smoke tests: a spawned `claude` subprocess inherits the host's
    settings, hooks, and CLAUDE.md auto-discovery. When the host has a
    stop-hook installed, the agent's reasoning gets derailed into
    addressing the hook instead of the user's task. Need an explicit
    isolation mode: generate a per-agent settings file (via `--settings`),
    point at a clean config dir, and exclude host `.claude/` inheritance.
    Address in M0.3 before M1 lands hand-offs.

---

## 13. Out of Scope (explicitly)

- Visual workflow editor.
- Non-Claude model backends.
- Fine-tuning or RLHF loops on past runs.
- Auto-merging PRs without human approval.
