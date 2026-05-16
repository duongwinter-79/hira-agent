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
├── runtime/
│   ├── orchestrator/            # top-level loop, intent routing
│   ├── session/                 # Claude Code session manager
│   ├── bus/                     # inter-agent message bus
│   ├── state/                   # task graph, run journal
│   ├── memory/                  # long-term memory backend
│   ├── transport/               # CLI / HTTP / SDK surfaces
│   └── config/                  # settings, model selection, budgets
├── spec/                        # design docs (this file lives here later)
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
model: claude-opus-4-7        # overridable per task
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

### 4.4 Claude Code as substrate

Each agent maps to a Claude Code session created via the Claude Agent
SDK. The runtime:

- Builds the **system prompt** from the agent's `prompt` file + injected
  context (relevant memory, task description, hand-off payload).
- Sets the **tool allowlist** from the agent manifest.
- Runs the session **headless** (non-interactive), streaming events back
  to the orchestrator.
- Captures the final structured output and the transcript for the run
  journal.

This means Hira does not own the model loop — Claude Code does. Hira owns
*coordination*.

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
default_model: claude-opus-4-7
agents:
  developer:
    model: claude-opus-4-7
  knowledge:
    model: claude-haiku-4-5-20251001
budgets:
  per_run:
    max_handoffs: 30
    max_wall_clock_s: 600
memory:
  backend: sqlite+chroma
  path: .hira/memory
```

---

## 10. Tech Stack (proposed)

- **Language:** TypeScript for the runtime (matches Claude Agent SDK,
  best Claude Code integration). Plugins are language-agnostic — skills
  can shell out to anything.
- **Session driver:** Claude Agent SDK (headless Claude Code sessions).
- **State:** SQLite (via `better-sqlite3`) for task graph + run journal.
- **Memory:** SQLite for structured records + a local vector index
  (e.g. `sqlite-vec` or Chroma) for freeform notes.
- **Transport:** Local CLI first; HTTP server behind a flag.
- **Schemas:** JSON Schema for plugin input/output contracts; Zod at the
  TypeScript boundary.

Open question: pick TS vs Python before milestone M1.

---

## 11. Milestones

| Milestone | Scope |
| --------- | ----- |
| **M0 — Skeleton**     | Repo layout, plugin loader, agent manifests for all eight roles (empty prompts), one trivial run end-to-end through the orchestrator. |
| **M1 — Single track** | Orchestrator → Planner → Developer → Tester → Reviewer working on a real task. No memory yet. CLI surface only. |
| **M2 — Memory**       | Memory Maintainer wired up; ADRs and glossary written and queryable; Knowledge agent reads from memory. |
| **M3 — Robust hand-offs** | Typed envelopes validated, run journal replayable, budgets enforced, failure modes handled (agent timeout, schema mismatch). |
| **M4 — Surfaces**     | HTTP API, web UI shell, GitHub PR comment surface. |
| **M5 — Polish**       | Cost dashboards, per-agent model tuning, parallel review fan-out, plugin marketplace format. |

---

## 12. Open Questions

1. **Runtime language** — TS or Python? TS is closer to the Agent SDK
   and Claude Code; Python is closer to most ML/data tooling.
2. **Session reuse vs fresh spawn** — do we keep an agent's Claude Code
   session warm across hand-offs in the same Run, or spawn fresh each
   time? Trade-off: context continuity vs context pollution.
3. **Memory granularity** — what gets remembered automatically vs what
   requires an explicit "remember this" from the user?
4. **Conflict resolution** — when Reviewer rejects Developer's patch
   twice, who arbitrates? Orchestrator escalates to user, or Solution
   Architect adjudicates?
5. **Tool/permission model** — do we re-use Claude Code's permission
   prompts, or pre-approve based on the agent manifest's allowlist?

---

## 13. Out of Scope (explicitly)

- Visual workflow editor.
- Non-Claude model backends.
- Fine-tuning or RLHF loops on past runs.
- Auto-merging PRs without human approval.
