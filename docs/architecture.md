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

Phase 0 stub. This document captures the planning-stage architecture and will
be expanded with sequence diagrams and final interfaces in Phase 13.
