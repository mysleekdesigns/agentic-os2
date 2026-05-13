# Agent OS

[![CI](https://github.com/mysleekdesigns/agentic-os2/actions/workflows/ci.yml/badge.svg?branch=development)](https://github.com/mysleekdesigns/agentic-os2/actions/workflows/ci.yml)

A local-first, Claude Code Max–compatible developer operating layer for
creating, coordinating, observing, securing, evaluating, and improving AI
agents. Agent OS builds on top of Claude Code's native subagent, hook, and MCP
primitives and adds a provider-pluggable runtime so the same agent definitions
can run locally against a Claude Code Max login (no API key) or, when
configured, against hosted Anthropic or OpenAI APIs. Optional API/cloud
execution is supported but **never required** for the core workflow.

## Status

Phases 0–12 of [`PRD.md`](./PRD.md) are complete. Phase 13 — examples,
templates, and documentation — is in progress (this README and the docs index
below land in that phase).

- **Foundations + storage + registry (0–2)** — repo scaffold, SQLite + Drizzle
  schema, agent/tool/MCP registries.
- **Providers + policy + workflows + approvals (3–6)** — the
  `claude_code_local` provider, tool-call policy engine, durable workflow
  runner, approval queue.
- **Memory + observability + evals + CLI (7–10)** — scoped memory store,
  structured logs and traces, eval harness, and the `agent-os` CLI.
- **Optional API providers + security hardening (11–12)** — Anthropic and
  OpenAI API adapters (off by default) and the threat model / `doctor
--security` posture report.

`PRD.md` remains the source of truth for what ships next.

## Quickstart — Claude Code Max (no API key)

This path uses your existing Claude Code Max login via
`@anthropic-ai/claude-agent-sdk`. The scaffolded config ships with
`providers.claude_code_local.requires_api_key: false`, so no API key is read
or required for the default path.

```sh
npm install
npm run build
npm link
agent-os init .
agent-os agent sync
agent-os doctor
agent-os run code_reviewer "review the diff in this branch"
```

What each step does:

1. `npm install` — fetch dependencies (Node 20+ required; see
   [`package.json`](./package.json) `engines`).
2. `npm run build` — compile TypeScript into `dist/` so the `agent-os` binary
   exists.
3. `npm link` — put the `agent-os` binary on your `PATH` for the rest of the
   walkthrough (alternatively, run `node dist/cli/index.js`).
4. `agent-os init .` — scaffold a workspace: writes a default
   `agent-os.config.yaml` (with `requires_api_key: false`), seeds the SQLite
   store, and creates `agents/`, `workflows/`, `evals/`, and `.claude/`
   directories.
5. `agent-os agent sync` — copy `agents/<id>.md` definitions into
   `.claude/agents/<id>.md` so Claude Code's native subagent loader picks them
   up.
6. `agent-os doctor` — health-check the workspace: config, providers, MCP
   servers, and database migrations. Pass `--security` for the security
   posture subset.
7. `agent-os run code_reviewer "..."` — run an agent end-to-end and stream
   its transcript to stdout. The shipped `code_reviewer` template only
   requests `fs.read` and prompts for approval on `fs.write`.

## Quickstart — API mode (optional)

If you want to run agents against the hosted Anthropic or OpenAI APIs instead
of your Max login, enable the relevant provider in `agent-os.config.yaml`,
export the matching env var, and re-run `doctor`:

```sh
# 1. Set providers.anthropic_api.enabled: true in agent-os.config.yaml
#    (or run: agent-os provider enable anthropic_api)
# 2. Export the API key the config points at
export ANTHROPIC_API_KEY=sk-...
# 3. Confirm the provider is now wired up
agent-os doctor
```

See [`docs/api-mode.md`](./docs/api-mode.md) for the full version, including
OpenAI setup, model overrides, and cost considerations.

## Examples

Three example agents ship under [`agents/templates/`](./agents/templates/):

- **`code_reviewer`** — reviews diffs for correctness, security, and PRD
  alignment. Read-only by default, with `fs.write` gated by approval.
- **`doc_writer`** — drafts and maintains project documentation (README,
  `docs/`, architecture notes).
- **`research_agent`** — deep web and repository researcher; uses the
  Crawlforge MCP tools when available.

Two example workflows ship under [`workflows/examples/`](./workflows/examples/):

- **`bugfix_loop.yaml`** — plan, patch, test (unit + lint in parallel),
  review, and human-approve a bug fix.
- **`deep_research.yaml`** — research a topic, draft a report, review it,
  then publish or revise based on the verdict.

Run any of them with `agent-os run <agent-id> "<goal>"` or
`agent-os workflow run <workflow-id>` (e.g. `agent-os workflow run bugfix-loop`).
See [`docs/examples.md`](./docs/examples.md) for walkthroughs of each one.

## Project structure

```
.
├── src/         # TypeScript source — CLI, providers, registry, runner, storage
├── agents/      # Canonical agent definitions (templates/ ships defaults)
├── workflows/   # Workflow YAML definitions (examples/ ships defaults)
├── evals/       # Eval fixtures and persisted run reports
├── docs/        # Architecture, Max-mode, API-mode, security, ADRs
├── .claude/     # Claude Code surfaces — mirrored subagents, hooks, settings
└── tests/       # Vitest suites (unit + integration)
```

## CLI reference

The CLI lives in [`src/cli/`](./src/cli/) and is exposed as the `agent-os`
binary. Top-level commands:

| Command                         | What it does                                                           |
| ------------------------------- | ---------------------------------------------------------------------- |
| `agent-os init <dir>`           | Scaffold a workspace (config, SQLite, directories, `.claude/`).        |
| `agent-os doctor`               | Health-check config, providers, MCP servers, and database.             |
| `agent-os doctor --security`    | Emit just the security posture subset of the doctor report.            |
| `agent-os agent list`           | List agents known to the registry.                                     |
| `agent-os agent show <id>`      | Show a single agent's frontmatter, tools, and policy.                  |
| `agent-os agent sync`           | Mirror `agents/<id>.md` into `.claude/agents/<id>.md` for Claude Code. |
| `agent-os agent new <id>`       | Scaffold a new agent definition.                                       |
| `agent-os run <id> "<goal>"`    | Run an agent end-to-end and stream the transcript.                     |
| `agent-os workflow list`        | List workflow definitions in the workspace.                            |
| `agent-os workflow run <p>`     | Execute a workflow YAML; durable, resumable.                           |
| `agent-os workflow resume`      | Resume a paused workflow run by id.                                    |
| `agent-os workflow cancel`      | Cancel an in-flight workflow run.                                      |
| `agent-os workflow show <id>`   | Show a run's spans, steps, and pending approvals.                      |
| `agent-os eval run [target]`    | Discover and run eval fixtures; persist a run report.                  |
| `agent-os eval diff <a> <b>`    | Diff two persisted eval run reports.                                   |
| `agent-os approvals list`       | List queued approval requests.                                         |
| `agent-os approvals show <id>`  | Show a single approval request.                                        |
| `agent-os approvals approve`    | Approve a pending request (also `reject`, `revise`).                   |
| `agent-os memory list`          | List memory entries (optionally filtered by scope).                    |
| `agent-os memory show <ref>`    | Show a memory entry by id or `scope:key`.                              |
| `agent-os memory write`         | Create or update a memory entry.                                       |
| `agent-os memory rm <ref>`      | Delete (tombstone) a memory entry.                                     |
| `agent-os memory search <q>`    | Keyword (and optional semantic) search across memory.                  |
| `agent-os provider list`        | List providers with capability and API-key status.                     |
| `agent-os provider enable <id>` | Enable (or `--disable`) a provider in `agent-os.config.yaml`.          |
| `agent-os tools list`           | List tools known to the tool registry.                                 |
| `agent-os tools test <id>`      | Dry-run the policy decision for a tool id (does not invoke it).        |
| `agent-os show <run-id>`        | Show the timeline of any run (agent or workflow) by id.                |
| `agent-os logs`                 | Show recent workspace events in reverse chronological order.           |

## Documentation

Everything under [`docs/`](./docs/), grouped by audience:

- [`docs/claude-code-max.md`](./docs/claude-code-max.md) — the local,
  no-API-key path (default for Max users).
- [`docs/api-mode.md`](./docs/api-mode.md) — enabling Anthropic or OpenAI as
  paid providers when you need them.
- [`docs/architecture.md`](./docs/architecture.md) — system overview, the
  registry/runner/policy split, and how the runtime composes.
- [`docs/security.md`](./docs/security.md) — security posture, default-deny
  tool policy, and secret redaction.
- [`docs/threat-model.md`](./docs/threat-model.md) — Phase 12 threat model:
  what we defend against and what's out of scope.
- [`docs/memory.md`](./docs/memory.md) — scoped memory store, retrieval, and
  optional semantic search via `sqlite-vec`.
- [`docs/examples.md`](./docs/examples.md) — walkthroughs of the shipped
  agents and workflows.
- [`docs/decisions/`](./docs/decisions/) — architecture decision records
  (ADRs). Start with
  [`0001-stack.md`](./docs/decisions/0001-stack.md).

## Contributing / development

Source of truth for what's planned and what's done is [`PRD.md`](./PRD.md).
Each phase is implemented behind the `/next-phase` skill and audited against
the PRD's quality bar ("works locally with no API key").

Local development loop:

```sh
npm run typecheck   # tsc --noEmit
npm run lint        # eslint .
npm test            # vitest run
npm run build       # tsc -> dist/
```

Formatting is enforced by Prettier (`npm run format`); a `PostToolUse`
Claude Code hook formats edited files automatically.

When extending the system, prefer the scaffolding skills under
`.claude/skills/` — `add-agent-template`, `add-provider`, `add-cli-command`,
`add-migration` — which generate code, tests, and slash-command wrappers in
the conventional layout.

## License

License: see `LICENSE`.
