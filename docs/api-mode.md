# Agent OS — API mode

## Why API mode exists

Agent OS is local-first. The default provider, `claude_code_local`, drives the
Claude Code CLI under a Claude Max login — no API key required, no cloud
round-trip, full local control over tools, hooks, and MCP. PRD §1.1 names this
as the primary surface: the developer's own machine, working against their
existing Max subscription.

API mode is the secondary surface. Users who already pay for an Anthropic or
OpenAI API key may want token-level cost metering, explicit prompt-cache
control, or access to a model the local harness cannot route to. The
provider abstraction (PRD §2.2) was designed so the same agent definition can
target any of the three backends. Phase 11's outcome states it directly:

> Users with API keys can run any agent against Anthropic or OpenAI without
> changing the agent definition.

Nothing about the agent body, the success criteria, the tool allow-list, or
the memory scopes changes when you flip a provider. The only deltas are
which backend executes the model call and which capabilities are honest about
themselves (see the matrix below).

## How to flip an agent to API mode

There are three single-line changes, in any order:

1. **Enable the provider.** Edit `agent-os.config.yaml`:

   ```yaml
   providers:
     anthropic_api:
       enabled: true
       api_key_env: ANTHROPIC_API_KEY
   ```

   Or use the CLI, which writes back to the same file:

   ```sh
   agent-os provider enable anthropic_api
   ```

2. **Export the key.** Agent OS reads keys from the environment at call time;
   they are never persisted to disk and never logged.

   ```sh
   export ANTHROPIC_API_KEY=sk-ant-...
   ```

3. **Point the agent at the provider.** In `agents/<id>.md` frontmatter:

   ```yaml
   provider: anthropic_api
   model: claude-opus-4-5
   ```

   No other field changes. The agent body, the `tools.allowed` list, the
   `permissions` block, the `memory` scopes, and the `eval` fixtures are all
   the same prose / data they were under `claude_code_local`.

For ad-hoc swaps without editing the agent file, pass `--provider` on the
CLI:

```sh
agent-os run <agent-id> --provider anthropic_api
```

The override applies for that one run and does not write back to the file.

## Capability matrix

The honest source of truth is `defaultCapabilitiesFor(id)` in
`src/core/providers/capabilities.ts`. Adapters may override individual flags
at construction time when a specific model lacks a capability (e.g. a non-vision
model under `anthropic_api`).

| Capability    | claude_code_local | anthropic_api | openai_api |
| ------------- | ----------------- | ------------- | ---------- |
| streaming     | ✅                | ✅            | ✅         |
| tools         | ✅                | ✅            | ✅         |
| mcp           | ✅                | ❌            | ❌         |
| vision        | ✅                | ✅            | ✅         |
| costMetering  | ❌                | ✅            | ✅         |
| promptCaching | ❌                | ✅            | ❌         |

The ❌ cells are not aspirational gaps. Each one is grounded in what the
backend actually exposes:

- **`claude_code_local` ❌ costMetering.** The Max plan does not expose per-call
  token metering through the Claude Agent SDK. The harness has no honest
  number to surface, so `done` events omit `tokens` and `cost`. Reading
  PRD §1.6: Max mode is a flat-rate subscription; per-call dollar metering
  would invent data that does not exist.

- **`claude_code_local` ❌ promptCaching.** The SDK does not expose the prompt
  cache primitive to Agent OS, so we cannot mark cache breakpoints from the
  agent. Inference-side caching may still occur transparently — the
  capability flag is about user-visible control, not silent server behaviour.

- **`anthropic_api` ❌ mcp.** The Messages API does not accept the OS-level
  `.mcp.json` shape. MCP under Anthropic API mode must either run client-side
  via `claude_code_local`, or be replaced with a hand-rolled tool integration
  the agent invokes directly. PRD Phase 11 leaves the door open to revisit
  this if Anthropic ships a server-side MCP shim.

- **`openai_api` ❌ mcp.** Same `.mcp.json` reason — the OpenAI Responses API
  does not accept the Agent OS MCP shape. If your agent depends on a pinned
  MCP server, keep it on `claude_code_local`.

- **`openai_api` ❌ promptCaching.** OpenAI's prompt cache is implicit and
  server-controlled — the SDK does not expose user-controllable cache
  breakpoints. We surface `false` rather than misrepresent server-side
  behaviour as user-visible.

## Secrets handling

The Phase 11 outcome includes a hard security bar: API keys come from the
environment, never from a config file, never written to logs, and redacted in
traces. The repo enforces this in three places:

- **Env-only read path.** Provider adapters read `ANTHROPIC_API_KEY` /
  `OPENAI_API_KEY` (and `CLAUDE_API_KEY` if set) from `process.env` at call
  time. They are not persisted to SQLite, not echoed into events, and never
  written to `agent-os.config.yaml` — the config file holds the env-var
  _name_, not the value.

- **Audit redaction.** `redactSecrets` in `src/core/tools/audit.ts` runs over
  every tool call's `args` and `result` payload before the blob is written
  (gated by `security.redact_secrets_in_logs: true`, which is the schema
  default). Phase 11 added a third pass on top of the existing key-name and
  vendor-pattern scrubbers: any live env value for the guarded provider keys
  is substring-stripped from every string the redactor sees. A header echo
  that contains a raw `sk-ant-…` value is therefore scrubbed even if the
  surrounding pattern heuristic fails. The env is re-read on each call so a
  rotated key does not linger in a cached set.

- **Trace redaction.** The span emitter
  (`src/core/observability/emitter.ts`) routes span attributes through
  `redactSecretValues` before persisting to `traces.otel_span_json`. The
  in-flight `SpanRecord` retains accurate values for live tooling; only the
  persisted JSON is scrubbed. The same redaction also flows into the OTLP
  exporter via `spanToPersistedJson`, so an external collector receives the
  same sanitised payload that lands on disk.

The policy is wired in `agent-os.config.yaml` under `security`. The optional
`secret_patterns` list lets operators extend the built-in vendor patterns
with workspace-specific regexes — e.g. a corporate token format — so that
in-house API keys are redacted alongside the shipped ones.

```yaml
security:
  redact_secrets_in_logs: true
  secret_patterns:
    - 'corp_[A-Za-z0-9]{32}'
```

See `docs/security.md` for the full audit-log shape and the
`security.risk_levels` policy.

## What stays identical across providers

The contract is intentionally narrow. These do not change when you flip a
provider:

- The agent file: `id`, `role`, instruction body, `tools.allowed`,
  `permissions`, `memory.read` / `memory.write`, `eval` fixtures.
- The user-facing goal and the success criteria.
- The `RunEvent` stream the CLI and the evals harness consume —
  `message`, `tool_call`, `tool_result`, `error`, `done` arrive in the same
  shape regardless of backend.

What does change is honest metadata on the events:

- `done` events from `anthropic_api` / `openai_api` carry `tokens` and `cost`
  (because the API exposes them); `done` events from `claude_code_local`
  carry `null` for those fields (because the Max SDK does not surface them).
- `.mcp.json` plumbing is only honoured by `claude_code_local`. API
  providers ignore the file; an agent that relies on MCP must either stay on
  the local harness or be rewritten against direct tool integrations.

## Pointers

- Adapter source: `src/providers/anthropic_api/`, `src/providers/openai_api/`.
- Capability matrix definition: `src/core/providers/capabilities.ts`.
- Redaction source: `src/core/tools/audit.ts`
  (`redactSecrets`, `redactSecretValues`, `getGuardedSecrets`).
- Trace persistence: `src/core/observability/emitter.ts`.
- CLI provider toggle: `agent-os provider enable <id>` (Phase 10).
- PRD references: §1.1 (motivation), §2.2 (Provider interface), §2.5
  (security config), §3 Phase 11 (this surface).
