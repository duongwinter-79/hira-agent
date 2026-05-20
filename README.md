# Hira Agent

> A multi-agent orchestration layer on top of Claude Code. Hira spawns
> specialised Claude Code sessions (planner, architect, developer,
> tester, reviewer, …), coordinates them with a typed hand-off bus, and
> presents one coherent reply to the user.

For the full design rationale, decisions, and trade-offs see
[`SPEC.md`](./SPEC.md). This README is the short tour.

---

## Purpose

Claude Code is excellent as a single-agent coding session, but real
software work is multi-disciplinary: it needs planning, design,
implementation, testing, review, research, and long-term memory. Today
the user has to context-switch one session through every mode, and the
session forgets context between runs.

Hira sits **above** Claude Code, not inside it:

- **Plugins** declare what the system can do (skills) and who knows how
  to do it (agents).
- **Runtime** decides which agent runs next, wires hand-offs between
  them, and journals every Run so it can be replayed and inspected.

Each agent is a managed `claude` subprocess — Hira does not re-implement
the model loop, it composes sessions. Auth flows through your existing
Claude Code login, so all model usage bills against the Pro/Max
subscription, not API tokens.

---

## Architecture

```
                 ┌──────────────────────────────────────┐
   User ───────► │            Orchestrator              │ ◄── CLI surface
                 └─────────────┬────────────────────────┘
                               │ classify intent
                               │   → reply directly, or
                               │   → dispatch via Bus
              ┌────────────────┼─────────────────┬───────────┬───────────┐
              ▼                ▼                 ▼           ▼           ▼
          Planner       Solution           Developer     Tester     Reviewer
                        Architect              │
                                               │
                                       ┌───────┴────────┐
                                       │  Knowledge     │  (codebase / docs / web)
                                       │  Memory        │  (long-term store)
                                       └────────────────┘
```

Five runtime sub-systems, kept deliberately small:

1. **Orchestrator** — the only agent the user talks to. Classifies
   intent and either replies or dispatches.
2. **Session driver** (`@hira/session`) — spawns `claude -p` with the
   target agent's effective system prompt, per-agent isolation
   (`--setting-sources ""` + a generated `settings.json` so host hooks
   and CLAUDE.md do not leak in), captures the stream-json events.
3. **Bus** (`@hira/runtime`) — single primitive `Bus.dispatch(envelope)`
   that enforces escalation rules, frames the envelope, journals the
   hand-off, extracts the agent's fenced JSON reply.
4. **Journal** (`@hira/journal`) — append-only JSONL run log at
   `.hira/runs/<run_id>/journal.jsonl`. Tracks runs, hand-offs (with
   `parent_handoff_id` linking), and artifacts with stable IDs
   (`kind:run_id_short:seq`) so a Run is fully replayable and walkable
   in either direction.
5. **Memory** (`@hira/memory`, in development) — SQLite + vector index
   for decisions, conventions, glossary, and task outcomes across Runs.

A **hand-off envelope** is a typed message: `from`, `to`, `kind`,
`payload`, `artifacts[]`, with forward-compatibility for the
deterministic Verification Engine and spec/ADR deltas (see SPEC §4.8).

Each agent is configured by a YAML manifest under `plugins/agents/`:
system prompt path, tool allowlist, allowed escalation targets,
behavioural skills (e.g. Karpathy guidelines), session lifecycle mode
(`fresh` per hand-off by default, `warm` for tight Developer ↔ Reviewer
loops).

---

## Tech stack

- **TypeScript**, ESM only, Node 20+.
- **pnpm** workspaces; **tsup** builds; **vitest** tests; **eslint** +
  **prettier**.
- **Claude Code CLI** as the substrate — spawned via `node:child_process`
  in headless mode (`-p --output-format stream-json --verbose`), authed
  via the host's `claude login`.
- **zod** for runtime schema validation (agent manifests, hand-off
  envelopes); plain YAML for manifests on disk.
- **JSONL** run journal today; SQLite + `sqlite-vec` planned once
  cross-run trace queries need indexes.

---

## Prerequisites

- **Node 20+** and **pnpm 10+**.
- **Claude Code CLI** on `PATH` and authenticated with a Pro or Max
  subscription:

  ```sh
  claude --version    # 2.x
  claude login        # one-time, opens browser OAuth flow
  ```

  All model usage is metered against this subscription. No
  `ANTHROPIC_API_KEY` required.

---

## Install and build

```sh
git clone https://github.com/duongwinter-79/hira-agent.git
cd hira-agent
pnpm install
pnpm -r build
```

That gives you a self-contained `packages/cli/dist/index.js` (the CLI
bundles all its workspace and npm dependencies).

### Run without installing globally

```sh
node packages/cli/dist/index.js <command> ...
```

### Install globally so `hira` works from any directory

The CLI ships with a `hira` bin entry. Link it into your global
pnpm bin directory:

```sh
# One-time pnpm setup if you have not done it before.
# Appends PNPM_HOME + PATH lines to your shell rc; reload your shell after.
pnpm setup

# From the repo root:
pnpm --filter @hira/cli link --global
```

Verify:

```sh
which hira          # /<your-pnpm-home>/hira
cd /some/other/dir
hira agents list    # finds Hira's bundled agents from the install dir
```

The CLI locates Hira's `plugins/` by walking up from its own binary
location, so `pnpm link --global` "just works" — the symlink points
back into your checkout. You can override with `--plugins-root <path>`
or `HIRA_PLUGINS_ROOT=<path>` if you want to point at a different
install.

If you prefer not to use pnpm's global linker, two alternatives work
just as well:

```sh
# Plain symlink into any directory already on $PATH:
ln -s "$PWD/packages/cli/dist/index.js" ~/.local/bin/hira

# Or a shell alias in ~/.bashrc or ~/.zshrc:
alias hira="node /absolute/path/to/hira-agent/packages/cli/dist/index.js"
```

To upgrade after a `git pull`, just re-run `pnpm -r build` — the link
points at `dist/index.js`, which gets refreshed in place.

---

## How to run

Once linked, run from any project directory. The CLI separates two
roots:

- **Plugins root** — where Hira's agents and skills live. Auto-detected
  from the binary's install location; override with `--plugins-root`
  or `HIRA_PLUGINS_ROOT`.
- **Project root** — where `.hira/runs/` is written and where spawned
  agents operate (the `claude` cwd). Defaults to the current directory;
  override with `--project`.

```sh
# List the configured agents and where each can escalate.
hira agents list

# Send a message to the Orchestrator. The journal for this Run lands
# in <cwd>/.hira/runs/<run_id>/.
hira run "<your message>"

# Inspect the journal.
hira runs list
hira runs show <run_id>

# Trace a Run or an artifact, both directions (requirement ↔ task ↔ artifact).
hira runs trace <run_id>
hira runs trace <artifact_id>      # e.g. verification:1a2b3c4d:1

# Approve a Run to fold its memory deltas into the baseline, or reject it.
hira runs approve <run_id>
hira runs reject <run_id>

# Inspect the cross-Run memory store.
hira memory list
hira memory query "<keywords>"

# See the assembled `claude` invocation without spawning it.
hira run --dry-run "<message>"
```

If you haven't linked it globally, prefix every command with
`node packages/cli/dist/index.js`.

---

## Configuration

An optional `hira.config.json` at the project root drives the
deterministic Verification Engine. After a Developer hand-off the
runtime runs each declared check and feeds the structured result into
the Reviewer:

```json
{
  "verification": {
    "checks": [
      { "name": "build", "command": "pnpm -r build", "timeout_ms": 180000 },
      { "name": "test", "command": "pnpm -r test" }
    ]
  }
}
```

Each check is a shell command run from the project root; a non-zero
exit marks the stage `fail`. With no `hira.config.json` the engine
reports `skipped` — there is no auto-detection, the checks are exactly
what you declare.

---

## Example usage

### Direct reply

The Orchestrator decides the question doesn't need decomposition and
answers in one hop.

```text
$ node packages/cli/dist/index.js run "What is 7 times 8? Reply with just the number."
56
(run_id: 8e9049a7-ee6d-4670-b943-8c50805da5b5)
```

### Dispatched plan

A real planning request flows user → orchestrator → planner. The
Planner returns a typed task graph.

```text
$ node packages/cli/dist/index.js run "Plan how to add a per-IP rate limiter to a Flask login endpoint."
Dispatched to planner. Plan:
{
  "tasks": [
    {"id":"t1","description":"Survey Flask rate-limiting libraries …","owner":"knowledge","depends_on":[]},
    {"id":"t2","description":"Design the rate-limiting architecture …","owner":"solution-architect","depends_on":["t1"]},
    {"id":"t3","description":"Implement the per-IP rate limiter …","owner":"developer","depends_on":["t2"]},
    {"id":"t4","description":"Write automated tests …","owner":"tester","depends_on":["t3"]},
    {"id":"t5","description":"Review the implementation and tests …","owner":"reviewer","depends_on":["t4"]}
  ],
  "rationale": "A linear knowledge → design → build → test → review chain is natural here …"
}
(run_id: b6436d38-067e-4745-935f-c8275403d8be)
```

### Inspecting the hand-off tree

```text
$ node packages/cli/dist/index.js runs show b6436d38-067e-4745-935f-c8275403d8be
Run b6436d38-067e-4745-935f-c8275403d8be
  status:  succeeded
  started: 2026-05-17T09:13:47.571Z
  ended:   2026-05-17T09:14:12.852Z
  intent:  Plan how to add a per-IP rate limiter to a Flask login endpoint.

Hand-offs (2):
  - 57a9a0c8-…  request    user → orchestrator      completed (4.2s)
      session_id: 48562088-…
      reply: Dispatching this to the planner …
  - 163d48e6-…  request    orchestrator → planner   completed (21.1s)  parent=57a9a0c8-…
      session_id: 932c4d0a-…
      reply: Here is the decomposed task graph …
```

---

## Repository layout

```
hira-agent/
├── plugins/
│   ├── agents/                 # one directory per role
│   │   ├── orchestrator/       # agent.yaml + system.md
│   │   ├── planner/
│   │   ├── solution-architect/
│   │   ├── developer/
│   │   ├── tester/
│   │   ├── reviewer/
│   │   ├── knowledge/
│   │   └── memory/
│   └── skills/
│       └── karpathy-guidelines/  # behavioural skill (SKILL.md format)
├── packages/                   # pnpm workspace
│   ├── plugin-loader/          # @hira/plugin-loader  (zod-validated manifest discovery)
│   ├── session/                # @hira/session        (claude CLI subprocess driver, isolation, skill resolver)
│   ├── journal/                # @hira/journal        (JSONL run journal, Handoff envelope schema)
│   ├── memory/                 # @hira/memory         (placeholder)
│   ├── runtime/                # @hira/runtime        (Bus + fenced-JSON extractor; surface re-exports)
│   └── cli/                    # @hira/cli            (`hira` user-facing CLI)
├── .hira/                      # runtime artefacts (gitignored)
│   └── runs/<run_id>/          # per-run journals, per-agent isolation settings
├── SPEC.md                     # design doc, decisions, open questions
└── README.md
```

---

## Tests

```sh
pnpm -r test                                 # unit tests only (no model calls)
HIRA_E2E=1 pnpm --filter @hira/session test  # opt-in: spawns claude and asserts a clean reply
```

Unit tests use a fake driver, so the suite is free, fast, and offline.
The opt-in e2e suite requires `claude login` and burns subscription
quota.
