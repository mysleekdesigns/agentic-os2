---
name: add-provider
description: Scaffold a new Provider adapter implementing the Agent OS Provider interface. Trigger when the user asks to "add a provider for X", "wire up Anthropic API", "wire up OpenAI", "add a Vertex provider", "stub a new provider", or invokes /add-provider. Generates the adapter under src/providers/<id>/, the capabilities matrix, the RunEvent stream mapping, and a contract test that exercises message/tool_call/tool_result/error/done. Targets PRD §2.2, Phase 3, Phase 11.
---

# add-provider — Provider adapter scaffold

You scaffold a new Provider adapter for the Agent OS project. The canonical interface is **PRD §2.2**; per-adapter expectations are in **Phase 3** (claude_code_local) and **Phase 11** (anthropic_api, openai_api).

## Hard rules

- Every adapter implements the `Provider` interface unchanged. If the interface needs an addition, that's a PRD change, not a per-adapter change — stop and ask.
- `capabilities` flags must be honest. Don't set `true` for behavior the adapter doesn't actually implement (PRD §2.2).
- `cost` / `tokens` fields are **nullable**. Only adapters that genuinely meter cost may populate them — others emit `null` and let the UI render `—` (PRD §1.5).
- `claude_code_local` must NOT require an API key (PRD §1.1, Phase 3). Other adapters read keys from env (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) and must redact them in logs.
- Each adapter must pass MCP server config through if the underlying SDK supports it (PRD Phase 3 exit criterion).

## Procedure

### Step 1 — Confirm the provider id and SDK

From the user request, extract:
- **provider id**: lowercase snake_case (`claude_code_local`, `anthropic_api`, `openai_api`, `vertex_ai`, ...)
- **SDK**: which npm package the adapter wraps
- **auth mode**: max-plan login (claude_code_local), API key (anthropic_api / openai_api), or other
- **expected capabilities**: streaming? tools? MCP? vision? cost metering?

Restate in one line: "Adding `<id>` adapter on top of `<sdk>`, auth via `<mode>`."

If the provider id is not in the PRD §2.2 union (`claude_code_local | anthropic_api | openai_api`), this requires a PRD update too — flag it.

### Step 2 — Read the Provider interface

Read `src/core/providers/` (or wherever the interface lives — check `src/core/` first, fall back to `src/providers/types.ts`). If the interface does not yet exist, this is Phase 3 territory — bootstrap it first using PRD §2.2 verbatim:

```ts
export interface Capabilities {
  streaming: boolean;
  tools: boolean;
  mcp: boolean;
  vision: boolean;
  costMetering: boolean;
  // extend with caution — must match PRD §2.2
}

export interface AgentRunInput {
  agentId: string;
  prompt: string;
  mcpServers?: McpServerConfig[];
  // ...
}

export type RunEvent =
  | { type: 'message'; text: string }
  | { type: 'tool_call'; tool: string; args: unknown; risk: RiskTag }
  | { type: 'tool_result'; tool: string; result: unknown; latencyMs: number }
  | { type: 'approval_requested'; reason: string; tool: string }
  | { type: 'error'; error: Error; recoverable: boolean }
  | { type: 'done'; cost: number | null; tokens: { input: number; output: number } | null };

export interface Provider {
  id: 'claude_code_local' | 'anthropic_api' | 'openai_api';
  capabilities: Capabilities;
  run(input: AgentRunInput): AsyncIterable<RunEvent>;
}
```

### Step 3 — Create the adapter

Files under `src/providers/<id>/`:
- `index.ts` — exports `create<Id>Provider(config): Provider`.
- `capabilities.ts` — exports the const `capabilities: Capabilities` for this adapter. Be honest.
- `run.ts` — the `run()` implementation: opens the SDK stream, maps SDK events → `RunEvent` union, yields them.
- `auth.ts` — for API providers, reads the key from env at first use (lazy). For `claude_code_local`, this file does not exist.

Mapping rules (per PRD Phase 3 / 11):
- SDK assistant tokens → `{ type: 'message', text }`
- SDK tool-use start → `{ type: 'tool_call', tool, args, risk }` (risk tag from the project's tool registry, not from the SDK)
- SDK tool result → `{ type: 'tool_result', tool, result, latencyMs }`
- SDK error → `{ type: 'error', error, recoverable }` (decide recoverability by error class)
- SDK end-of-stream → `{ type: 'done', cost, tokens }` — for `claude_code_local`, both fields are `null`; for API providers, populate from real usage data.

### Step 4 — Contract test

File: `tests/providers/<id>.contract.test.ts`.

Use a fake SDK (or `vi.mock(...)`) so the test runs offline. Assert:
- The adapter's `capabilities` object has every Capabilities key (no missing flags).
- Calling `run()` yields events whose `type` is in the RunEvent union and nothing else.
- Calling `run()` eventually yields exactly one `done` event.
- For `claude_code_local`: `done.cost === null` and `done.tokens === null`.
- For API providers: when the fake SDK reports usage, `done.cost` and `done.tokens` are populated.
- No `ANTHROPIC_API_KEY` is read by `claude_code_local` (spy on `process.env`).

### Step 5 — Capability matrix doc

If `docs/api-mode.md` exists (PRD Phase 11), add or update the matrix row for this adapter. Otherwise, add a TODO line in the adapter's `index.ts`:

```ts
// TODO(Phase 11): document this provider in docs/api-mode.md when that doc exists.
```

### Step 6 — Hand off

Print a 6-line summary:
- Adapter: `src/providers/<id>/index.ts`
- Capabilities: `src/providers/<id>/capabilities.ts`
- Run loop: `src/providers/<id>/run.ts`
- Test: `tests/providers/<id>.contract.test.ts`
- Doc note: <where the capability matrix entry goes>
- Audit it: invoke the `provider-capability-auditor` subagent before merging.

## What this skill does not do

- It does NOT install npm packages. If the SDK isn't already in `package.json`, stop and ask.
- It does NOT enable the provider in `agent-os.config.yaml` — that's a user decision (PRD Phase 11: `agent-os provider enable <id>`).
- It does NOT modify the Provider interface itself.
