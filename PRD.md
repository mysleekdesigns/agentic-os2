# Agent OS — Product Requirements Document

> A local-first, Claude Code Max–compatible developer operating layer for creating,
> coordinating, observing, securing, evaluating, and improving AI agents. Optional
> API/cloud execution is supported but never required for the core workflow.

---

## 0. Document Status

- **Date**: 2026-05-12
- **Owner**: Simon Lacey (`simon@dashboardhosting.com`)
- **Repository**: `agentic-os2` (new project, near-empty repo; clean stack choice possible)
- **Mode**: Planning only. No code in this PRD.
- **Working title**: `agent-os`

---

## 1. Research Summary

Research was conducted via Crawlforge MCP across 50+ sources spanning agent
platforms, Claude Code/MCP, orchestration, memory, evaluation, observability,
durable execution, and security. Key findings condensed below.

### 1.1 Claude Code is already a partial Agent OS

Claude Code (Max plan) ships with the primitives most agent platforms invent:

- **Subagents** — markdown files in `.claude/agents/*.md` with YAML frontmatter
  (`name`, `description`, `tools`, `model`) define delegatable specialist agents.
  Anthropic's docs and the August 2025 release patterns make this the canonical
  delegation surface (`code.claude.com/docs/en/sub-agents`).
- **Hooks** — `PreToolUse`, `PostToolUse`, `Stop`, etc. configured in
  `settings.json` or agent frontmatter; the perfect injection point for
  approval gates, audit logging, and policy enforcement
  (`code.claude.com/docs/en/hooks`).
- **MCP** — first-class Model Context Protocol client; servers can be declared
  in `.mcp.json` (project-scope) or user settings; supports stdio/SSE/HTTP.
- **Skills, Slash Commands, Plugins** — additional layered surfaces for
  packaging reusable behavior (`levelup.gitconnected.com`, `blog.sshh.io`).
- **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) — exposes the Claude
  Code harness programmatically. **Critically, it can authenticate via an
  existing Claude Code Max login, no API key required**
  (`code.claude.com/docs/en/headless`, `augmentcode.com`).

**Implication**: Agent OS must **build on top of** these primitives rather than
reinvent them. The system's value is the layer above — registry, orchestrator,
approval flows, memory, observability, evals — using Claude Code as the runtime.

### 1.2 Multi-agent orchestration patterns

- Anthropic's own research system (`anthropic.com/engineering/multi-agent-research-system`)
  uses an **orchestrator-worker** topology: a lead agent decomposes work and
  spawns parallel specialist subagents. Subagents are isolated context windows;
  outputs are summarized back to the orchestrator.
- **LangGraph** — explicit DAG/state machine; powerful but heavy and Python-first.
- **CrewAI** — role-based "crew" abstraction; opinionated and high-level.
- **AutoGen** — event-driven multi-agent conversation; now merged with Semantic
  Kernel into Microsoft Agent Framework (Oct 2025).
- **OpenAI Agents SDK** (replaced Swarm, Mar 2025) — minimal: agent + tools +
  handoffs + tracing. Often cited as the best DX baseline.
- **Mastra** — TypeScript-native, agent-first, ergonomic; the closest "Node
  spiritual sibling" to the OpenAI Agents SDK.

**Adopt**: orchestrator-worker topology, explicit handoffs (OpenAI Agents SDK
style), file-defined agents (CrewAI/Claude Code style), graph-able workflows
when needed (LangGraph-lite).

**Avoid**: framework lock-in, heavy DSLs, mandatory in-memory state, hidden
auto-routing that hides what the agent is doing.

### 1.3 Durable execution & human-in-the-loop

- **Inngest** and **Temporal** both solve the "agent runs for hours, must
  survive crashes, must pause for human input" problem
  (`inngest.com/blog/durable-execution-key-to-harnessing-ai-agents`,
  `akka.io/blog/inngest-vs-temporal`).
- Both are heavy dependencies. For a local-first system, we can get 80% of the
  value with a **SQLite-backed durable task table** + a worker loop that
  persists step state and supports `awaiting_approval` / `awaiting_event` states.
- Upgrade path: a `WorkflowEngine` interface allows swapping to Inngest or
  Temporal in cloud mode without changing agent definitions.

### 1.4 Memory & vector storage

- **SQLite + `sqlite-vec`** (successor to sqlite-vss) is the clear local-first
  winner: embedded, no server, ANN-capable, runs in Bun/Node.
- **LanceDB** — embedded multimodal lakehouse, strong alternative if scale
  matters locally (`cognee.ai`, `mem0.ai` use it as default).
- **pgvector** — the standard for cloud Postgres deployments.
- Memory shape from Anthropic's _Effective Context Engineering_ (Sep 2025):
  treat context as finite; prefer **just-in-time retrieval** over stuffing;
  use **subagent specialization for context isolation**; write durable notes
  to disk between turns rather than rehydrating long histories.

**Adopt**: SQLite + sqlite-vec default; pluggable VectorStore interface; explicit
memory scopes (session/project/user/agent) with read/write policies per agent.

### 1.5 Observability

- **OpenTelemetry GenAI Semantic Conventions** (in development; v1.37+ widely
  supported by Datadog, Langfuse, MLflow, Arize Phoenix) are the emerging
  standard for LLM/agent traces (`opentelemetry.io/docs/specs/semconv/gen-ai`).
- **Langfuse** and **Arize Phoenix** are open-source, OTel-native, and run
  locally — both are credible self-hosted backends.
- For Claude Code local mode, token cost/usage is often **not reliably
  available** (subscription billing). System must degrade gracefully — record
  latency, tool calls, decisions, errors; mark cost fields nullable.

**Adopt**: emit OTel GenAI-shaped spans to local SQLite by default; optional
OTLP exporter to any OTel backend.

### 1.6 Evaluation

- **Promptfoo** — open-source, CLI-first, YAML eval suites, runs locally,
  no SaaS dependency. Best fit for local-first agent OS.
- **Braintrust** / **Langfuse evals** / **DeepEval** / **Arize Phoenix** —
  more powerful but lean cloud or heavier setup.
- Practical pattern: ship Promptfoo-compatible YAML fixtures + a thin runner
  that records results to the same SQLite store as runtime traces, enabling
  "trace ↔ eval" correlation.

### 1.7 MCP & agent security

- Real CVEs and exploits in 2025:
  - **CVE-2025-49596**: RCE via exposed MCP Inspector.
  - SQLite MCP prompt-injection chains (`towardsdatascience.com`).
  - "Tool poisoning" via tool descriptions, "rug-pull" servers, confused
    deputy via cross-server tool calls (`embracethered.com`).
- Defenses: source verification, signed/locked MCP servers, sandboxed
  execution boundaries, structured tool outputs, principle of least privilege,
  explicit approval for network/shell/file-write tools, deny by default
  (`redhat.com`, `zenity.io`, `paloaltonetworks.com`).

**Adopt**: deny-by-default tool policy; per-agent allow-lists; risk-tagged
tools (`read`, `write`, `network`, `shell`, `destructive`); MCP server pinning
with checksums; hook-based PreToolUse policy enforcement.

### 1.8 Stack choice — TypeScript / Node

The user's repo already configures a Node-based MCP server (`.mcp.json` →
`crawlforge-mcp-server/server.js`). The Claude Agent SDK and the MCP SDK both
have first-class TypeScript support. **TypeScript on Node 20+ is the chosen
stack.** Python users can still drive the system via the CLI; no Python
runtime is required.

### 1.9 Selected sources (representative)

| Topic                  | Source                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code subagents  | `code.claude.com/docs/en/sub-agents`                                                                                                                                                                                                                                                                                                                      |
| Claude Code hooks      | `code.claude.com/docs/en/hooks`                                                                                                                                                                                                                                                                                                                           |
| Claude Agent SDK       | `npmjs.com/package/@anthropic-ai/claude-agent-sdk`, `code.claude.com/docs/en/headless`                                                                                                                                                                                                                                                                    |
| Best practices         | `code.claude.com/docs/en/best-practices`, `blog.sshh.io/p/how-i-use-every-claude-code-feature`                                                                                                                                                                                                                                                            |
| Multi-agent research   | `anthropic.com/engineering/multi-agent-research-system`                                                                                                                                                                                                                                                                                                   |
| Context engineering    | `anthropic.com/engineering/effective-context-engineering-for-ai-agents`, `langchain.com/blog/context-engineering-for-agents`                                                                                                                                                                                                                              |
| Framework comparison   | `langfuse.com/blog/2025-03-19-ai-agent-comparison`, `composio.dev/content/openai-agents-sdk-vs-langgraph-vs-autogen-vs-crewai`, `openagents.org/blog/posts/2026-02-23-open-source-ai-agent-frameworks-compared`                                                                                                                                           |
| Durable execution      | `inngest.com/blog/durable-execution-key-to-harnessing-ai-agents`, `akka.io/blog/inngest-vs-temporal`                                                                                                                                                                                                                                                      |
| Vector storage         | `cognee.ai/blog/fundamentals/how-cognee-builds-ai-memory`, `mem0.ai/blog/crewai-memory-production-setup-with-mem0`                                                                                                                                                                                                                                        |
| OTel for GenAI         | `opentelemetry.io/docs/specs/semconv/gen-ai`, `opentelemetry.io/blog/2025/ai-agent-observability`, `datadoghq.com/blog/llm-otel-semantic-convention`                                                                                                                                                                                                      |
| Evals                  | `augmentcode.com/tools/best-ai-agent-evaluation-tools`, `braintrust.dev/articles/deepeval-alternatives-2026`                                                                                                                                                                                                                                              |
| MCP security           | `redhat.com/en/blog/model-context-protocol-mcp-understanding-security-risks-and-controls`, `towardsdatascience.com/the-mcp-security-survival-guide-best-practices-pitfalls-and-real-world-lessons`, `embracethered.com/blog/posts/2025/model-context-protocol-security-risks-and-exploits`, `backslash.security/blog/claude-code-security-best-practices` |
| Claude Max as endpoint | `reddit.com/r/ClaudeAI/comments/1r0ugjm/...`, `linkedin.com/posts/tom-swift_openclaw-claudecode-opensource-...`                                                                                                                                                                                                                                           |

### 1.10 What to adopt vs avoid (one-pager)

**Adopt**

- File-based agent definitions (`.md` + YAML frontmatter), Claude Code–compatible.
- Orchestrator-worker topology with explicit handoffs.
- SQLite-first storage; sqlite-vec for embeddings; OTel-shaped traces.
- Deny-by-default tool permissions; risk tagging; hook-based enforcement.
- Just-in-time context retrieval over context stuffing.
- Provider abstraction with `claude_code_local` as default (no API key).
- Promptfoo-compatible eval fixtures.

**Avoid**

- Heavy framework dependencies (LangGraph/AutoGen/Temporal) in the local core.
- Mandatory cloud services or API keys.
- Auto-routing/hidden agent selection.
- Unconstrained memory writes.
- Reinventing Claude Code primitives we can build on.

---

## 2. Architecture

### 2.1 High-level

```
┌──────────────────────────────────────────────────────────────────────┐
│                      Developer (Claude Code Max)                     │
│   uses CLI, slash commands, or just talks to Claude inside the CLI   │
└──────────────────────────────────────────────────────────────────────┘
                                  │
                ┌─────────────────┴──────────────────┐
                ▼                                    ▼
        ┌───────────────┐                  ┌──────────────────┐
        │   agent-os    │                  │   Claude Code    │
        │     CLI       │◀────────────────▶│    (harness)     │
        └───────┬───────┘                  └────────┬─────────┘
                │                                   │
                │   reads/writes file-based config  │
                │   spawns runs via Provider        │
                ▼                                   ▼
   ┌──────────────────────────────────────────────────────────┐
   │                       Agent OS Core                       │
   │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐  │
   │  │ Registry │ │  Tasks   │ │Approvals │ │   Memory     │  │
   │  └──────────┘ └──────────┘ └──────────┘ └──────────────┘  │
   │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐  │
   │  │  Tools/  │ │Observab- │ │  Evals   │ │  Providers   │  │
   │  │   MCP    │ │  ility   │ │          │ │ (adapters)   │  │
   │  └──────────┘ └──────────┘ └──────────┘ └──────────────┘  │
   └──────────────────────────────────────────────────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
       ┌─────────────┐    ┌─────────────┐    ┌─────────────────┐
       │ SQLite + vec│    │  File store │    │   MCP servers   │
       │  (default)  │    │ (agents/    │    │ (Crawlforge,    │
       │             │    │  workflows) │    │   filesystem…)  │
       └─────────────┘    └─────────────┘    └─────────────────┘
```

### 2.2 Provider abstraction

A single `Provider` interface separates orchestration from execution:

```
interface Provider {
  id: 'claude_code_local' | 'anthropic_api' | 'openai_api'
  capabilities: { streaming, tools, mcp, vision, costMetering, ... }
  run(input: AgentRunInput): AsyncIterable<RunEvent>
}
```

Provider backends (priority order):

1. **`claude_code_local`** — default. Drives the local Claude Code harness via
   the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) using the user's
   existing Max login. No API key. MCP servers passed through. Token cost
   nullable.
2. **`anthropic_api`** — direct Anthropic SDK. Requires `ANTHROPIC_API_KEY`.
   Full cost/token metering. Used for hosted runs, background workers, or
   parallel scale beyond Max plan limits.
3. **`openai_api`** — optional, for non-Anthropic models. Requires
   `OPENAI_API_KEY`. Capability flags will mark some Anthropic-only features
   (computer use, etc.) as unavailable.

Switching provider for any agent is a single field change in its YAML; no
agent definition is provider-locked.

### 2.3 Repository layout (target)

```
agentic-os2/
├── PRD.md                       # this document
├── README.md
├── package.json                 # TS, Bun-or-Node, Drizzle, Zod
├── tsconfig.json
├── agent-os.config.yaml         # runtime/provider/security/memory config
├── .mcp.json                    # already present
├── .claude/
│   ├── agents/                  # native Claude Code subagents (mirrors registry)
│   ├── commands/                # slash commands that wrap CLI
│   └── hooks/                   # PreToolUse / Stop hooks for approvals + audit
├── agents/                      # canonical agent definitions (md+yaml)
│   ├── templates/
│   └── examples/
├── workflows/
│   └── examples/
├── memory/                      # filesystem-scoped memory notes
├── evals/
│   ├── fixtures/
│   └── results/
├── logs/                        # human-readable rollups (DB is source of truth)
├── docs/
│   ├── architecture.md
│   ├── claude-code-max.md
│   ├── api-mode.md
│   ├── security.md
│   ├── threat-model.md
│   └── examples.md
├── src/
│   ├── cli/                     # commander/oclif entrypoint
│   ├── core/
│   │   ├── agents/              # registry, loader, schema
│   │   ├── tasks/               # orchestrator, scheduler, durable state
│   │   ├── tools/               # tool registry + permission engine
│   │   ├── memory/              # scopes, vector store, write policy
│   │   ├── approvals/           # gates, queue, CLI/UI review
│   │   ├── observability/       # OTel spans, run timelines, logs
│   │   ├── evals/               # runner + adapters (promptfoo-compat)
│   │   └── providers/           # Provider interface, capability flags
│   ├── providers/
│   │   ├── claude_code_local/   # Claude Agent SDK adapter
│   │   ├── anthropic_api/
│   │   └── openai_api/
│   ├── storage/                 # SQLite + sqlite-vec, drizzle schema/migrations
│   ├── config/                  # config loader, env, secrets indirection
│   └── security/                # policy engine, sandbox helpers
├── tests/
└── (optional later) web/        # Next.js dashboard
```

### 2.4 Data model (initial)

SQLite tables (Drizzle):

- `agents(id, version, definition_path, hash, created_at)` — registry pointer
  table; canonical source remains the YAML/md file.
- `runs(id, agent_id, workflow_id?, parent_run_id?, status, started_at, ended_at, provider, model, summary)`
- `steps(id, run_id, kind, name, input_ref, output_ref, status, started_at, ended_at, error)`
- `tool_calls(id, step_id, tool, args_ref, result_ref, risk, approved_by?, latency_ms, status)`
- `approvals(id, run_id?, step_id?, requested_by, action, status, decided_by?, decided_at, reason)`
- `memory(id, scope, agent_id?, key, value_ref, embedding_id?, created_at, updated_at)`
- `embeddings(id, vector, metadata)` (sqlite-vec table)
- `traces(id, run_id, otel_span_json)`
- `eval_results(id, fixture_id, run_id?, score, passed, details_ref, created_at)`
- `events(id, kind, payload, created_at)` — append-only audit log.

All large payloads (inputs/outputs) are stored as blobs in `blobs/` with hash
addresses; tables reference by hash. This keeps the DB compact and content
diffable across runs.

### 2.5 Configuration shape (proposed)

```yaml
# agent-os.config.yaml
runtime:
  default_provider: claude_code_local
  storage: local_sqlite
  workspace_root: .
  require_approval_for_risky_tools: true

providers:
  claude_code_local:
    enabled: true
    requires_api_key: false
    sdk: '@anthropic-ai/claude-agent-sdk'
  anthropic_api:
    enabled: false
    api_key_env: ANTHROPIC_API_KEY
  openai_api:
    enabled: false
    api_key_env: OPENAI_API_KEY

security:
  default_tool_policy: deny
  risk_levels:
    read: allow
    write: approval_required
    network: approval_required
    shell: approval_required
    destructive: deny
  pinned_mcp_servers: true # require checksum match
  redact_secrets_in_logs: true

memory:
  enabled: true
  storage: local
  semantic_search: optional # sqlite-vec
  default_scopes: [project, user_preferences]

observability:
  local_logs: true
  traces: true
  otlp_exporter:
    enabled: false
    endpoint: ''

approvals:
  channels: [cli] # later: web, slack, github
  default_ttl_minutes: 60
```

### 2.6 Agent definition shape (proposed)

```yaml
# agents/research_agent.md
---
id: research_agent
name: Research Agent
version: 1
role: Deep web and repository researcher
provider: claude_code_local # any provider id
model: opus # optional, provider decides default
tools:
  allowed:
    - mcp.crawlforge.search_web
    - mcp.crawlforge.fetch_url
    - fs.read
  approval_required:
    - fs.write
permissions:
  network: approval_required
  file_read: allow
  file_write: approval_required
  shell: deny
memory:
  read: [project, user_preferences]
  write: [research_notes]
eval:
  fixtures: evals/fixtures/research/*.yaml
  success_criteria:
    - cites credible sources
    - identifies tradeoffs
    - compares alternatives
---
# Instructions

Use available MCP tools to research deeply. Prefer primary sources. Summarize
findings with citations. ...
```

The same file is the canonical agent definition AND can be symlinked or mirrored
into `.claude/agents/` so Claude Code's native subagent system can use it
directly when running inside the CLI.

---

## 3. Phased Implementation Plan

Each phase has an outcome, scope, checklist, and exit criteria. Phases are
ordered by dependency, not necessarily by calendar.

### Phase 0 — Foundation & repository setup ✅ COMPLETE (2026-05-12)

**Outcome**: Clean TypeScript repo, lint/format, baseline docs, decision log.

- [x] Initialize TypeScript project (Node 20+; Bun supported but not required).
- [x] Add `package.json`, `tsconfig.json`, ESLint, Prettier, Vitest.
- [x] Add `agent-os.config.yaml` skeleton + Zod schema (`src/config/schema.ts`, `src/config/index.ts`).
- [x] Add `docs/architecture.md` stub with diagram from §2.
- [x] Add `docs/decisions/0001-stack.md` recording TypeScript choice.
- [x] `.gitignore` already covers `cache/`, `logs/`, `blobs/`, `.env` (and more); verified.
- [x] Confirmed `.mcp.json` Crawlforge entry is present and unchanged.

**Exit (met)**: `npm test` green (3 tests across `tests/cli.test.ts` and `tests/config.test.ts`); `node dist/cli/index.js --version` prints `0.0.1`; `npm run typecheck` and `npm run lint` clean.

**Artifacts shipped**: `package.json`, `tsconfig.json`, `.eslintrc.cjs`, `.prettierrc.json`, `vitest.config.ts`, `.nvmrc`, `src/cli/index.ts` (with `--version` and `doctor` placeholder), `src/config/{schema.ts,index.ts}`, `agent-os.config.yaml`, `docs/architecture.md`, `docs/decisions/0001-stack.md`, rewritten `README.md`.

---

### Phase 1 — Storage & config layer ✅ COMPLETE (2026-05-12)

**Outcome**: SQLite database, migrations, blob store, typed config loader.

- [x] Add Drizzle ORM + `better-sqlite3` (or `libsql`) driver.
- [x] Define migrations for tables in §2.4.
- [x] Add content-addressed blob store helper (`writeBlob(buf) → sha256`).
- [x] Add config loader that reads `agent-os.config.yaml` and env vars,
      validates with Zod, exposes typed `Config` object.
- [x] Add `sqlite-vec` extension load + fallback for environments without it
      (semantic search marked disabled in capabilities).
- [x] Provide `agent-os init` to scaffold `agents/`, `workflows/`, `evals/`,
      `.agent-os/` (DB dir), and a default config.

**Exit (met)**: `npm test` green (33 tests across `tests/cli.test.ts`,
`tests/config.test.ts`, `tests/cli/init.test.ts`, `tests/storage/blobs.test.ts`,
`tests/storage/schema.test.ts`, `tests/storage/vec.test.ts`); `npm run
typecheck` and `npm run lint` clean; sqlite-vec loaded successfully and
`vec_version()` smoke test passes; `agent-os init` scaffolds 12 directories and
a validated default config; auditor `drizzle-schema-reviewer` returned PASS
WITH NITS; `verify-no-api-key` gate PASS with `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `CLAUDE_API_KEY` unset.

**Artifacts shipped**: `src/storage/{db.ts,schema.ts,migrate.ts,vec.ts,capabilities.ts,blobs.ts}`,
`drizzle/migrations/{0001_init.sql,0002_embeddings_vec.sql}`, `drizzle.config.ts`,
`src/cli/commands/init.ts`, updated `src/cli/index.ts`, updated
`src/config/index.ts` with env-var overlay (`AGENT_OS_*`), new tests
`tests/storage/{schema.test.ts,vec.test.ts,blobs.test.ts}` and
`tests/cli/init.test.ts`, expanded `tests/config.test.ts`, `package.json` adds
`better-sqlite3`, `drizzle-orm`, `sqlite-vec` (deps) + `drizzle-kit`,
`@types/better-sqlite3` (dev) + `db:migrate` script. Also fixes
`.claude/hooks/protect-prd.sh` to read user turns from `transcript_path`
(the field Claude Code actually provides) rather than the non-existent
`.session.user_prompt`.

**Known follow-ups** (auditor nits, recorded for later phases):

- Memory scope CHECK constraint is `('global','agent','run')`; Phase 7 will
  widen to PRD §2.5 scopes and allow user-defined scopes.
- `embeddings` vec0 dimension is hardcoded `float[1536]`; Phase 7 should make
  it configurable from `memory.embedding_dim`.
- `tryLoadVec` should smoke-test `vec_version()` before re-calling
  `vec.load(sqlite)` to avoid "extension already loaded" on double-probe.
- `_agent_os_migrations.status` concatenates the failure reason; split into a
  separate `reason` column.
- Add `BEFORE UPDATE/DELETE` triggers on `events` to enforce append-only at
  the DB layer (Phase 12 audit posture).
- Add explicit no-down rollback note on `0001_init.sql` (forward-only by
  design for local-first SQLite).

---

### Phase 2 — Agent Registry ✅ COMPLETE (2026-05-12)

**Outcome**: File-based agent definitions are loaded, validated, versioned,
and visible via CLI.

- [x] Define agent file format (md + YAML frontmatter, see §2.6).
- [x] Implement loader that walks `agents/`, parses, validates with Zod.
- [x] Hash + version each agent definition; record in `agents` table.
- [x] Add `agent-os agent list` and `agent-os agent show <id>` commands.
- [x] Add 3 starter templates (`research_agent`, `code_reviewer`,
      `doc_writer`) in `agents/templates/`.
- [x] Mirror agent files into `.claude/agents/` so Claude Code's native
      subagent loader sees them. (`agent-os agent sync` command.)
- [x] Document the dual-purpose nature in `docs/claude-code-max.md`.

**Exit (met)**: `npm test` green (64 tests across 11 files, including 24 new
tests covering schema/loader/registry/mirror/CLI); `npm run typecheck` and
`npm run lint` clean; `agent-os agent list/show/sync` work end-to-end against
a tmp workspace; canonical files at `agents/templates/*` validate against the
Zod schema; `sync` writes mirror files to `.claude/agents/<id>.md` with a
synthesized `description` field and upserts rows into the `agents` registry
table. Auditors: `eval-fixture-author` PASS WITH NITS (starter smoke fixtures
shipped per agent, voice-matching criteria deferred to Phase 9);
`mcp-security-auditor` PASS WITH NITS (id-slug constraint added during phase
to close the only medium finding). `verify-no-api-key` PASS with
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CLAUDE_API_KEY` unset (tests +
typecheck + lint + CLI smoke).

**Artifacts shipped**: `src/core/agents/{schema.ts,loader.ts,registry.ts,mirror.ts,index.ts}`,
`src/cli/commands/agent.ts` (subcommands `list`, `show`, `sync`, each with
`--json`), updated `src/cli/index.ts`, slash-command wrappers
`.claude/commands/{agent-list,agent-show,agent-sync}.md`, starter templates
`agents/templates/{research_agent,code_reviewer,doc_writer}.md`, starter
Promptfoo-compatible smoke fixtures
`evals/fixtures/{research_agent,code_reviewer,doc_writer}/smoke.yaml`,
docs `docs/claude-code-max.md`, new tests
`tests/core/agents/{schema,loader,registry,mirror}.test.ts` and
`tests/cli/agent.test.ts`.

**Known follow-ups** (auditor nits, recorded for later phases):

- Phase 9 should add edge/adversarial/regression fixture cases to each agent's
  `evals/fixtures/<id>/` directory; `smoke.yaml` covers happy-path only.
- Phase 9 should decide whether `doc_writer`'s "matches existing voice" gets a
  deterministic surrogate (e.g. avg sentence length) or stays model-graded.
- Phase 12 policy engine should reject any agent file with a
  `write|network|shell|destructive`-tagged tool listed in `tools.allowed`
  rather than `tools.approval_required`.
- `mirror.ts` synthesizes the Claude Code `description` from `role`; add a
  unit-test fixture covering YAML-significant characters in `role` to lock in
  js-yaml's quoting behaviour.
- Consider embedding the canonical file hash as a comment in the mirrored
  `.claude/agents/<id>.md` so drift detection still works if a user hand-edits
  the mirror.

---

### Phase 3 — Provider abstraction (Claude Code local mode)

**Outcome**: Agents can be run end-to-end with zero API key, using the user's
Claude Code Max login.

- [ ] Define `Provider` interface, `Capabilities`, `RunEvent` union.
- [ ] Implement `claude_code_local` provider backed by
      `@anthropic-ai/claude-agent-sdk`.
- [ ] Pass MCP server config from `.mcp.json` through to the SDK so tools work.
- [ ] Stream `RunEvent`s back: `message`, `tool_call`, `tool_result`,
      `approval_requested`, `error`, `done`.
- [ ] Mark `cost`/`tokens` fields nullable for this provider; surface what
      the SDK exposes.
- [ ] Add `agent-os run <agent-id> "<goal>"` CLI command that drives a single
      agent through the provider and prints a clean transcript.

**Exit**: `agent-os run research_agent "summarize Crawlforge MCP tools"`
completes locally with no API key set.

---

### Phase 4 — Tool / MCP permission layer

**Outcome**: Every tool call is policy-checked, risk-tagged, audited, and (when
required) gated by approval.

- [ ] Define tool risk tags: `read | write | network | shell | destructive`.
- [ ] Build policy engine: per-agent allow-lists + global defaults + risk
      thresholds.
- [ ] Implement PreToolUse hook (Claude Code hook + provider-level interceptor)
      that calls the engine and either allows, denies, or queues for approval.
- [ ] Log every `tool_call` row with: tool id, args hash, risk, decision,
      latency, result hash, error.
- [ ] Add MCP server pinning: optional `checksum` in `.mcp.json` enforced by
      a `PreToolUse` hook.
- [ ] Document the threat model touched here in `docs/security.md`.

**Exit**: Calling a disallowed tool is blocked with a clear message; calling
a "write" tool triggers an approval prompt; audit log records both.

---

### Phase 5 — Task / workflow orchestrator

**Outcome**: Multi-step workflows can be defined, run, paused, resumed,
retried, and inspected.

- [ ] Define workflow file format (YAML) supporting:
      sequential steps, parallel fan-out, conditional handoffs, approval gates,
      retries with backoff, timeouts, `awaiting_event` waits.
- [ ] Implement durable executor: each step persisted to `steps` table;
      restart-safe; idempotency by step id.
- [ ] Implement orchestrator-worker topology: a lead agent can spawn worker
      subagents (matches Claude Code subagent semantics).
- [ ] Add CLI: `workflow list`, `workflow run`, `workflow resume <run-id>`,
      `workflow cancel <run-id>`, `workflow show <run-id>`.
- [ ] Provide 2 example workflows: `deep_research` (research → write → review),
      `bugfix_loop` (plan → patch → test → review → approve).

**Exit**: Killing the process mid-workflow then re-running `workflow resume`
continues from the last completed step.

---

### Phase 6 — Human approval system

**Outcome**: Risky actions can be paused until a human approves, rejects, or
revises them; decisions are auditable.

- [ ] Implement approval queue in `approvals` table with TTL + expiration.
- [ ] CLI: `agent-os approvals list`, `approvals show <id>`,
      `approvals approve|reject|revise <id> [--note ...]`.
- [ ] Hook integration: when a tool/step is gated, the run enters
      `awaiting_approval`; the orchestrator does not poll — it resumes when
      an approval event lands.
- [ ] Configurable policies (per agent, per tool, per workflow).
- [ ] Audit log every decision with who/when/why.

**Exit**: A workflow that writes a file pauses, shows up in `approvals list`,
and resumes correctly on approve.

---

### Phase 7 — Memory system

**Outcome**: Agents have scoped, inspectable memory with explicit read/write
policies; no uncontrolled writes.

- [ ] Implement scopes: `session`, `agent`, `project`, `user_preferences`,
      plus arbitrary named scopes declared in agent YAML.
- [ ] Storage: file-backed `memory/<scope>/*.md` for human-readable memories;
      SQLite index for lookup; sqlite-vec for semantic search (optional).
- [ ] Enforce per-agent `memory.read` / `memory.write` allow-lists at the
      provider boundary.
- [ ] CLI: `memory list <scope>`, `memory show <id>`, `memory write <scope>
<key>`, `memory rm <id>`, `memory search "<query>" [--scope ...]`.
- [ ] Document write policy: append by default; updates require diff; deletes
      are tombstoned, not destructive.
- [ ] Provide a `MEMORY.md` index pattern compatible with Claude Code's
      conversation context loading.

**Exit**: An agent without `memory.write: notes` cannot create a `notes`
memory even if it tries; the attempt is logged.

---

### Phase 8 — Observability

**Outcome**: Every run is traceable from start to finish; failed runs are
debuggable; data is local by default and exportable to OTel.

- [ ] Emit OTel-shaped spans per Anthropic GenAI semconv: `gen_ai.system`,
      `gen_ai.request.model`, `gen_ai.usage.*` (nullable for Max mode),
      tool spans, agent spans, retrieval spans.
- [ ] Persist spans to `traces` table; render local timeline via
      `agent-os run show <run-id>`.
- [ ] Optional OTLP exporter (off by default; one config flag turns it on).
- [ ] Searchable local log view: `agent-os logs [--agent ...] [--since ...]`.
- [ ] Graceful degradation when cost/tokens are unavailable — UI shows "—"
      rather than fabricating numbers.

**Exit**: After a multi-step run, `run show` prints a tree of agent calls,
tool calls, durations, and outcomes that matches reality.

---

### Phase 9 — Evaluation framework

**Outcome**: Reproducible evaluations of agent behavior with regression
detection over time.

- [ ] Define eval fixture format (Promptfoo-compatible YAML where possible):
      input prompt, expected behaviors, scorers, dataset reference.
- [ ] Scorers: deterministic (regex, JSON shape, presence of citations),
      programmatic (custom JS), and optional model-graded (only when an
      API-backed provider is enabled; degrades cleanly otherwise).
- [ ] Eval runner: `agent-os eval run <fixture-or-dir>`; persists to
      `eval_results`.
- [ ] Compare runs: `agent-os eval diff <run-a> <run-b>`.
- [ ] Add CI-friendly exit codes and JSON output mode.
- [ ] Ship 2 example fixture suites (one per starter agent).

**Exit**: Eval suite runs locally, fails when an agent stops citing sources,
diffs cleanly between runs.

---

### Phase 10 — CLI developer interface

**Outcome**: A single ergonomic CLI that fronts every subsystem; safe to
invoke from Claude Code conversations.

- [ ] Choose CLI framework (commander.js or oclif).
- [ ] Implement top-level commands:
      `init`, `agent {list,show,new}`, `workflow {list,run,resume,show}`,
      `approvals {list,approve,reject,revise}`,
      `memory {list,show,write,rm,search}`,
      `tools {list,test}`,
      `run`, `logs`, `eval {run,diff}`,
      `provider {list,enable}`,
      `doctor` (health check), `version`.
- [ ] Friendly TTY output + `--json` everywhere for programmatic use.
- [ ] Ship `.claude/commands/*.md` slash commands that wrap common flows
      (`/agent-run`, `/workflow-run`, `/approvals`, `/memory`).
- [ ] Make every command help-discoverable from inside Claude Code.

**Exit**: A new user runs `agent-os doctor` and sees their config, provider
status, MCP server health, and DB version.

---

### Phase 11 — Optional API/cloud providers

**Outcome**: Users with API keys can run any agent against Anthropic or OpenAI
without changing the agent definition.

- [ ] Implement `anthropic_api` provider using the Anthropic SDK; full
      tool-use loop; prompt caching enabled by default; streaming.
- [ ] Implement `openai_api` provider using the OpenAI SDK; map tools; mark
      Anthropic-only capability flags unavailable.
- [ ] Secrets handling: keys come from env (`ANTHROPIC_API_KEY`,
      `OPENAI_API_KEY`); never written to logs; redacted in traces.
- [ ] Provider capability matrix documented in `docs/api-mode.md`.
- [ ] CLI: `agent-os provider enable <id>` writes back to config.

**Exit**: The same `research_agent` can be flipped to `anthropic_api` via one
config line and behaves identically (modulo cost telemetry now populated).

---

### Phase 12 — Security hardening

**Outcome**: System ships with sensible defaults and a written threat model.

- [ ] Write `docs/threat-model.md` covering: prompt injection via tool output,
      tool poisoning, confused deputy, MCP supply chain, secret exfiltration
      via memory, log leakage, sandbox escape via shell tools.
- [ ] Default deny for shell + destructive tools.
- [ ] Redact secrets in trace persistence (allow-list of regex patterns
      configurable in `agent-os.config.yaml`).
- [ ] Sandboxed shell execution helper (cwd whitelist, command allow-list).
- [ ] MCP server allow-list with optional checksum pinning; warn on
      unverified servers.
- [ ] Hook tying everything together: `PreToolUse` runs the policy engine for
      both Claude Code native runs and SDK-driven runs.
- [ ] Security test fixtures: deliberately malicious tool output to verify
      isolation.

**Exit**: Threat-model doc reviewed; security tests pass; `agent-os doctor
--security` reports clean.

---

### Phase 13 — Examples, templates, documentation

**Outcome**: A new user can go from zero to a working agent in <10 minutes,
following docs, on Claude Code Max.

- [ ] `docs/claude-code-max.md` — full Max-plan local setup (no API key).
- [ ] `docs/api-mode.md` — turning on API providers.
- [ ] `docs/architecture.md` — final architecture, sequence diagrams.
- [ ] `docs/security.md` + `docs/threat-model.md`.
- [ ] `docs/examples.md` — walk through each example agent + workflow.
- [ ] At minimum 3 example agents, 2 example workflows, 2 eval fixture suites.
- [ ] README rewrite with quickstart aimed at Max users.

**Exit**: Docs reviewed; example agents pass their own evals.

---

### Phase 14 — Tests

**Outcome**: Confidence that the core does not regress as the system grows.

- [ ] Unit tests for: config loader, agent loader, policy engine, blob store,
      memory scopes, workflow executor.
- [ ] Integration tests with a fake `Provider` that emits scripted events,
      covering: tool denial, approval flow, resume after crash, retry,
      memory enforcement, eval scoring.
- [ ] Smoke test that boots the CLI and runs `agent-os doctor`.
- [ ] CI workflow that runs lint + tests on every push.

**Exit**: `npm test` green; coverage report exists; CI badge in README.

---

### Phase 15 — Optional web dashboard

**Outcome (optional, behind a flag)**: A local web UI that mirrors the CLI for
runs, approvals, memory, and evals.

- [ ] Next.js app in `web/`, Tailwind + shadcn/ui, reads same SQLite DB.
- [ ] Pages: runs list & detail, approvals queue, memory browser, eval results.
- [ ] Auth: local-only by default (bound to `127.0.0.1`); auth required if
      bound to anything else.
- [ ] Started/stopped by `agent-os dashboard {start,stop}`.

**Exit**: Dashboard ships behind `--with-dashboard`; not required for any
core flow.

---

### Phase 16 — Cloud/deployment path (future)

**Outcome (future scope)**: System can be deployed as a hosted control plane.

- [ ] Postgres + pgvector adapters in `storage/` (interface already abstracted).
- [ ] Optional Inngest or Temporal adapter behind the `WorkflowEngine` interface.
- [ ] Container image + minimal deployment guide.
- [ ] Identity/multi-tenant model spec (out of scope for initial release).

**Exit**: Documented migration path; no breaking changes to local users.

---

## 4. Quality bar (definition of done)

A feature is done when:

- [ ] It works locally with **no API key**.
- [ ] Its behavior is covered by at least one test or eval fixture.
- [ ] Its public surface (CLI command, file format, config field) is documented.
- [ ] Risky operations have approval/audit hooks attached.
- [ ] Failures degrade gracefully — never crash the run loop on a recoverable
      error.

Project-level quality bar:

- [ ] First-class on Claude Code Max.
- [ ] Modular, swappable provider/storage/workflow interfaces.
- [ ] Secure by default (deny-by-default tool policy, redacted logs).
- [ ] Local-first, observable, testable.
- [ ] No placeholders, no half-implemented stubs in shipped code.

---

## 5. Open questions / decisions to revisit

- **Runtime**: Node vs Bun. Default Node 20+ for portability; verify Bun
  compatibility opportunistically.
- **SQLite driver**: `better-sqlite3` (sync, fast) vs `libsql` (Turso, edge).
  Default `better-sqlite3` locally; `libsql` adapter as upgrade path.
- **Sub-agent topology** in workflows: model as DAG or as message-passing?
  Initial choice — DAG with explicit edges; revisit when first complex
  multi-agent workflow is built.
- **Web dashboard**: ship or defer to community? Default — defer; ship CLI
  fully first.
- **Mem0 / Cognee integration** as memory backend: defer behind interface;
  evaluate after Phase 7 ships.
- **Eval scoring**: how much to lean on Promptfoo vs in-house. Default —
  fixture compatibility, in-house runner so we own the storage shape.

---

## 6. Out of scope (for the initial release)

- Multi-tenant hosted SaaS.
- Authentication/identity beyond local user.
- Non-Anthropic/OpenAI providers (Google, local Ollama) — interface allows
  them; implementations are post-v1.
- Mobile or browser-extension surfaces.
- Marketplace of agents/workflows.

---

## 7. Deliverables checklist (cross-phase rollup)

- [ ] Research summary (this PRD §1)
- [ ] Architecture document (§2 + `docs/architecture.md`)
- [x] Data model (§2.4)
- [x] Agent configuration schema (§2.6 + Zod)
- [ ] Workflow configuration schema (Phase 5)
- [ ] Provider abstraction with Claude Code local mode first (Phase 3)
- [ ] Optional API provider implementations (Phase 11)
- [ ] Tool/MCP permission model (Phase 4 + §1.7)
- [ ] Task orchestration engine (Phase 5)
- [ ] Memory abstraction (Phase 7)
- [ ] Human approval flow (Phase 6)
- [ ] Observability/logging layer (Phase 8)
- [ ] Eval framework (Phase 9)
- [ ] CLI interface (Phase 10)
- [ ] Tests (Phase 14)
- [x] Example agents (Phases 2 + 13)
- [ ] Example workflows (Phases 5 + 13)
- [ ] Documentation for Claude Code Max users (Phase 13)
- [ ] Documentation for API users (Phase 13)
- [ ] Security notes and threat model (Phase 12)
