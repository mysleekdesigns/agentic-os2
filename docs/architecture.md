# Agent OS — Architecture

## Overview

Agent OS is a local-first, Claude Code Max–compatible developer operating layer
for creating, coordinating, observing, securing, evaluating, and improving AI
agents. It builds directly on Claude Code primitives (subagents, hooks, MCP)
and exposes a provider-pluggable runtime so the same agent definitions can run
against the local Claude Code harness (no API key) or, when configured, against
hosted Anthropic or OpenAI APIs. Optional cloud execution is supported but
never required for the core workflow.

## High-level diagram

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

## Sequence diagrams

These diagrams trace the three runtime paths a developer hits in practice.
They are ASCII (not Mermaid) to match the rest of this document; the source
file paths are listed beside each step so a reader can jump to the code.

### (a) Agent run lifecycle

The single-agent path: `agent-os agent run <id> "<prompt>"`. The CLI loads
the agent definition, resolves a provider, wraps the provider's event stream
in the policy interceptor, and streams scrubbed events to the renderer.

```
 Developer       CLI (run.ts)         Registry         Providers         Interceptor       Policy        Approvals       Audit/Obs
   │                  │                   │                  │                 │                 │              │                │
   │ agent run X "p"  │                   │                  │                 │                 │              │                │
   ├─────────────────▶│                   │                  │                 │                 │              │                │
   │                  │ loadAgents()      │                  │                 │                 │              │                │
   │                  ├──────────────────▶│                  │                 │                 │              │                │
   │                  │◀── AgentDef ──────┤                  │                 │                 │              │                │
   │                  │ getProvider(id)   │                  │                 │                 │              │                │
   │                  ├──────────────────────────────────────▶                 │                 │              │                │
   │                  │◀── Provider ──────────────────────────┤                │                 │              │                │
   │                  │ interceptProviderStream(provider.run(input))           │                 │              │                │
   │                  ├──────────────────────────────────────────────────────▶│                 │              │                │
   │                  │                   │                  │ provider.run()  │                 │              │                │
   │                  │                   │                  ├────────────────▶│                 │              │                │
   │                  │                   │                  │   tool_call ev  │                 │              │                │
   │                  │                   │                  ├────────────────▶│ evaluate(tool,  │              │                │
   │                  │                   │                  │                 │   agent, sec)   │              │                │
   │                  │                   │                  │                 ├────────────────▶│              │                │
   │                  │                   │                  │                 │◀── decision ────┤              │                │
   │                  │                   │                  │                 │                 │              │                │
   │      ┌── decision = 'allow' ────────────────────────────│                 │                 │              │                │
   │      │           │                   │                  │                 │ onCall(...)     │              │                │
   │      │           │                   │                  │                 ├──────────────────────────────────────────────▶ │
   │      │           │                   │                  │ tool_call ▶▶ pass through ──▶ tool_result ev                     │
   │      │           │                   │                  │                 │ onResult(...)   │              │                │
   │      │           │                   │                  │                 ├──────────────────────────────────────────────▶ │
   │      ├── decision = 'approval_required' ─────────────────                 │                 │              │                │
   │      │           │                   │                  │                 │ approval_requested event                       │
   │      │           │                   │                  │◀────────────────┤                 │              │                │
   │      │           │                   │                  │                 │ createRequest()│              │                │
   │      │           │                   │                  │                 ├────────────────────────────▶│                │
   │      │           │                   │                  │                 │                 │ pending row │                │
   │      │           │                   │                  │                 │ synthetic tool_result{isError:true} → pause    │
   │      └── decision = 'deny' ─────────────────────────────┤                 │ synthetic tool_result{isError:true}            │
   │                  │ renderEvent(ev)   │                  │                 │                 │              │                │
   │◀─────────────────┤                   │                  │                 │                 │              │                │
   │                  │ done event → flush() spans + audit blobs                                                                 │
   │                  ├─────────────────────────────────────────────────────────────────────────────────────────────────────▶│
   │◀── exit code ────┤                   │                  │                 │                 │              │                │
```

Code path:
`src/cli/commands/run.ts` (`runAgent`) → `src/core/agents/loader.ts`
(`loadAgents`) → `src/core/providers/index.ts` (`getProvider`) →
`src/core/tools/interceptor.ts` (`interceptProviderStream`) →
`src/core/tools/policy.ts` (`evaluate`) →
`src/core/approvals/index.ts` (`createRequest`) →
`src/core/tools/audit.ts` (`createSqliteAuditor`) →
`src/core/observability/emitter.ts` (`createSpanEmitter`).

### (b) Approval flow (queue mode)

When the run is configured with `approvalMode: 'queue'` (Phase 6 default for
non-interactive runs), the interceptor does not block on a TTY resolver. It
persists an `approvals` row, emits `approval_requested`, and exits the
iterator. The operator unblocks the run out-of-band with the approvals CLI.

```
 Interceptor            approvals tbl        Operator         approvals CLI       Executor (resume)        Provider
       │                       │                  │                  │                    │                     │
       │ approval_requested    │                  │                  │                    │                     │
       │ createRequest({...})  │                  │                  │                    │                     │
       ├──────────────────────▶│                  │                  │                    │                     │
       │ pause iterator,       │                  │                  │                    │                     │
       │ run.status='pending'  │                  │                  │                    │                     │
       │                       │                  │ approvals list   │                    │                     │
       │                       │                  ├─────────────────▶│ listRequests()     │                     │
       │                       │◀──────────────── pending rows ──────┤                    │                     │
       │                       │                  │◀── table ────────┤                    │                     │
       │                       │                  │ approvals approve <id>                │                     │
       │                       │                  │   --decided-by alice                  │                     │
       │                       │                  ├─────────────────▶│ decideRequest()    │                     │
       │                       │◀──── status='approved' ─────────────┤                    │                     │
       │                       │                  │                  │ events row written │                     │
       │                       │                  │                  │ resumeWorkflow(runId)                   │
       │                       │                  │                  ├───────────────────▶│                     │
       │                       │                  │                  │                    │ rehydrate state    │
       │                       │◀── read approval ────────────────────────────────────────┤                     │
       │                       │                  │                  │                    │ re-run gated step  │
       │                       │                  │                  │                    ├────────────────────▶│
       │                       │                  │                  │                    │◀── tool_result ────┤
       │                       │                  │                  │                    │ continue to next step
```

Code path:
`src/core/tools/interceptor.ts` (queue branch in `interceptProviderStream`) →
`src/core/approvals/index.ts` (`createRequest`, `decideRequest`,
`listRequests`) → `src/cli/commands/approvals.ts` →
`src/core/tasks/executor.ts` (`resumeWorkflow`).

### (c) Workflow step execution

A workflow run is the multi-step path. The executor walks the DAG, claims
each step idempotently, dispatches it to an agent or sub-workflow, persists
inputs/outputs as blobs, and emits a span per step. An approval-gated step
folds into the flow in (b).

```
 CLI (workflow.ts)        Executor              steps tbl       Provider/Agent       Approvals      Spans / events
        │                     │                    │                  │                  │                  │
        │ workflow run W       │                    │                  │                  │                  │
        ├────────────────────▶│ loadWorkflow(W)     │                  │                  │                  │
        │                     │ insert run row     │                  │                  │                  │
        │                     ├───────────────────▶│                  │                  │                  │
        │                     │ workflow.start span                                                          │
        │                     ├────────────────────────────────────────────────────────────────────────────▶│
        │                     │ for step in DAG:    │                  │                  │                  │
        │                     │  claim step (scopedStepId)             │                  │                  │
        │                     ├───────────────────▶│                  │                  │                  │
        │                     │  spawn agent OR sub-workflow          │                  │                  │
        │                     ├──────────────────────────────────────▶│                  │                  │
        │                     │  ─── if tool_call needs approval, see (b) ──▶│           │                  │
        │                     │                    │                  │  createRequest()│                  │
        │                     │                    │                  ├────────────────▶│ pending row     │
        │                     │  pause → workflow_paused event                          │                  │
        │                     ├────────────────────────────────────────────────────────────────────────────▶│
        │                     │  ─── on resume, re-run step ────────────────────────────▶│                  │
        │                     │◀── result blob ─────────────────────── │                  │                  │
        │                     │ write steps.output_ref                │                  │                  │
        │                     ├───────────────────▶│                  │                  │                  │
        │                     │ workflow.step.end span                                                       │
        │                     ├────────────────────────────────────────────────────────────────────────────▶│
        │                     │ next step…         │                  │                  │                  │
        │◀── stream events ───┤                    │                  │                  │                  │
```

Code path:
`src/cli/commands/workflow.ts` → `src/core/tasks/executor.ts`
(`runWorkflow`, `resumeWorkflow`, `scopedStepId`) →
`src/core/tasks/orchestrator.ts` for fan-out → step execution dispatches
back into the (a) path per agent.

## Cross-cutting concerns

### Policy enforcement

The same `evaluate()` pure function runs whether the tool call originated in
Claude Code's harness (vetted out-of-process by the `PreToolUse` hook) or in
the SDK interceptor (in-process, wrapping the provider stream). Both surfaces
read the same `agent-os.config.yaml` `security` block and the same agent
`tools` allow-list / `approval_required` list, so a tool that requires
approval in one place requires approval in the other. The shipped defaults
are `default_tool_policy: deny`, `destructive: deny`, and `shell:
approval_required`. See `src/core/tools/policy.ts` for the decision logic
and `.claude/hooks/policy-runtime.sh` for the Claude Code wire-up.

### Secret redaction

Every audit blob and every persisted span attribute is scrubbed before it
hits disk or an OTLP collector. The redactor combines three sources:
built-in vendor patterns (e.g. `sk-ant-…`, `sk-…`), live env-var values for
configured provider keys (re-read on each call so rotation is honoured), and
the operator-supplied `security.secret_patterns` allow-list of additional
regexes. The audit path is `redactSecrets` in `src/core/tools/audit.ts`; the
trace path is `redactSecretValues` invoked by
`src/core/observability/emitter.ts` via `spanToPersistedJson`, which also
feeds the OTLP exporter so an external collector sees the same sanitised
payload as on-disk storage.

### Observability

Every run — agent or workflow — produces a span tree. Spans are persisted
into the `traces` table with the scrubbed attribute payload, alongside the
`events` audit log. When `observability.otlp_exporter.enabled: true` is set
in `agent-os.config.yaml`, the same scrubbed spans are forwarded to the
configured OTLP endpoint at flush time; nothing extra is exposed to the
collector beyond what already lives in `traces`. The wire-up is in
`src/core/observability/index.ts` (`createObservabilityFromConfig`,
`createSpanEmitter`, `createOtlpExporter`).

## Provider abstraction

A single `Provider` interface decouples orchestration from model execution.
Each provider declares its `capabilities` (streaming, tools, MCP, vision, cost
metering) and exposes a `run(input)` method that yields an async iterable of
`RunEvent`s. The default provider is `claude_code_local`, which drives the
Claude Code harness via `@anthropic-ai/claude-agent-sdk` using the user's
existing Max login — no API key required. `anthropic_api` and `openai_api`
providers are optional and selectable per agent via a single YAML field. See
PRD §2.2 for the full interface and priority order.

## Repository layout

The target directory tree is enumerated in PRD §2.3 and will fill in across
phases: `src/cli/`, `src/core/{agents,tasks,tools,memory,approvals,observability,evals,providers}`,
`src/providers/`, `src/storage/`, `src/config/`, `src/security/`, plus
top-level `agents/`, `workflows/`, `evals/`, `memory/`, `logs/`, and `docs/`.
Phase 0 only stands up the documentation and configuration shells; subsequent
phases land their respective subtrees.

## Data model

The system is SQLite-first (Drizzle ORM, `better-sqlite3` default). Core
tables include `agents`, `runs`, `steps`, `tool_calls`, `approvals`, `memory`,
`embeddings` (via `sqlite-vec`), `traces`, `eval_results`, and an append-only
`events` audit log. Large payloads (tool inputs/outputs, message bodies) are
content-addressed in a `blobs/` store and referenced by hash, keeping the DB
compact and diffable. See PRD §2.4 for the full schema.

## Configuration

Runtime, provider, security, memory, observability, and approval settings are
declared in `agent-os.config.yaml` at the repository root, loaded and
validated via a typed Zod schema. The same file is the source of truth for
provider enablement, default tool policy (deny-by-default), risk-tier
overrides, and OTLP exporter wiring. See `agent-os.config.yaml` and PRD §2.5
for the canonical shape.

## Status

Phase 13. Sequence diagrams and cross-cutting concerns are now expanded
against the shipped code paths. Earlier phases populated each box of the
high-level diagram: registry (Phase 2), providers (Phase 3, 11), tools and
policy (Phase 4), tasks and approvals (Phase 5, 6), memory (Phase 7),
observability (Phase 8), evals (Phase 9), CLI (Phase 10), security (Phase
12). See PRD §3 for the per-phase exit criteria.
