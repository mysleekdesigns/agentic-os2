# Agent OS — Security model

This document is the source of truth for the security posture introduced by
Phase 4 (Tool / MCP permission layer). It does not yet supersede the full
threat-model writeup planned for Phase 12 (`docs/threat-model.md`) — see the
"What Phase 4 does NOT do" section at the bottom for the deferred work.

The references throughout point at PRD sections (§n.m) rather than external
URLs so this document remains source-of-truth-local.

## Threat model summary

Agent OS runs LLM-driven agents that can call tools — file I/O, network
fetchers, shell commands, and third-party MCP servers — on the user's behalf.
The asymmetric risk is that a single bad tool call can leak secrets, mutate
the repo destructively, or be a vector for prompt injection from untrusted
input (web pages, MCP server outputs). Phase 4 therefore wires every tool call
through a policy engine, tags each tool with a coarse risk class, audits the
decision, and pins MCP servers to a content checksum so a swapped binary is
caught before it executes.

The PRD §1.7 enumerates the threats motivating this design. The table below
maps each threat to the control that mitigates it, where the work happens,
and what is explicitly out of scope for Phase 4.

| Threat                                | Source / shape                                                                    | Phase 4 control                                                                                                                                                | Deferred (Phase 12)                                |
| ------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Tool poisoning                        | A tool description (built-in or MCP) coaxes the agent into misuse.                | Risk-tagged tools + per-agent allow-list. The agent cannot call a tool it does not declare.                                                                    | Structured tool-output validators.                 |
| Confused deputy via cross-server call | One MCP server invokes another's high-privilege tool on the agent's behalf.       | Per-tool risk tag bubbles up; `approval_required` blocks the call until a human signs off.                                                                     | Per-server capability sandboxing.                  |
| MCP supply-chain compromise           | A pinned MCP binary is replaced upstream (rug-pull, dep injection).               | `command_sha256` pinning enforced by `loadMcpServers` AND the Claude Code hook `mcp-policy.sh`.                                                                | Signed manifests / provenance attestation.         |
| Secret exfiltration via memory        | An agent writes API keys or PII into long-term memory and a later run leaks them. | `memory.write` allow-list per agent (Phase 7); BlobStore is local-only.                                                                                        | Secret redaction on read / structured scrubbing.   |
| Log / trace leakage                   | Audit-log payloads carry secrets that surface in traces or `tasks show`.          | Coarse redactor in the auditor when `redact_secrets_in_logs: true`; `args_ref` / `result_ref` are hashes; raw bytes live in the BlobStore which is local-only. | Configurable regex rules (planned in §3 Phase 12). |
| Hook bypass                           | An agent or contributor tries to circumvent the PreToolUse policy.                | The hook is wired in `.claude/settings.json` AND duplicated SDK-side; both paths must approve.                                                                 | Codified hook integrity (signed hooks).            |
| Sandbox escape                        | A `shell` tool spawns a destructive command outside the workspace.                | `BUILTIN_TOOL_RISKS` flags `Bash`/`shell.exec` as `shell` (default `approval_required`); destructive built-ins are `destructive`.                              | Sandboxed shell helper / OS-level confinement.     |

## Risk tags

Every tool is classified into exactly one of five tags. The defaults live in
`src/core/tools/risk.ts` under `BUILTIN_TOOL_RISKS`; the classifier resolves
unknown names heuristically (MCP `mcp__<server>__<tool>` defaults to `network`,
upgraded to `write` if the suffix matches `write|edit|create|update|delete|rm|put|post|exec|send`).

| Tag           | Meaning                                                                                                                                | Example tool    |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `read`        | Observes state without mutation (files, structured data, search). Default action `allow`.                                              | `Read`, `Grep`  |
| `write`       | Mutates files or in-process state. Default action `approval_required`.                                                                 | `Edit`, `Write` |
| `network`     | Talks to an external service over the network. Default action `approval_required`.                                                     | `WebFetch`      |
| `shell`       | Spawns a subshell. Default action `approval_required`.                                                                                 | `Bash`          |
| `destructive` | Irreversible or unbounded mutation (recursive delete, schema drop). Default action `deny` — only opt-in per-agent override re-enables. | `fs.rm`         |

The risk-level → action table is configurable per workspace via
`security.risk_levels` in `agent-os.config.yaml`; the schema lives in
`src/config/schema.ts` (`RiskLevelsSchema`).

## Policy precedence

When the engine evaluates a tool call, the first rule that matches wins. The
order is fixed and lives in `src/core/tools/policy.ts`:

- If the resolved risk tag is `destructive` and `security.risk_levels.destructive`
  is `deny`, the call is denied. Destructive deny is the hardest-priority rule
  so an over-permissive agent file cannot re-enable it.
- If the agent's `tools.approval_required` list includes the tool, the call
  requires approval regardless of risk-level defaults.
- If `security.risk_levels[<tag>]` is `deny` or `approval_required`, that
  action applies — the risk class is the next-strongest signal.
- If the agent's `tools.allowed` list includes the tool, the call is allowed.
  The agent allow-list is the positive opt-in for tools that would otherwise
  fall to the default.
- Otherwise `security.default_tool_policy` decides (`deny` ships as the
  out-of-the-box default per the config schema in `src/config/schema.ts`).

Every decision is persisted as a `tool_calls` row carrying the rule that
fired (`risk_levels` | `agent_allow` | `agent_approval` | `default_tool_policy`
| `unknown_tool`), so audit consumers can answer "why was this allowed?"
deterministically.

## MCP server pinning

Pinning binds each MCP server entry to a content checksum. The shape is a
single optional field per server in `.mcp.json`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "/usr/local/bin/mcp-filesystem",
      "args": ["--root", "."],
      "command_sha256": "ab12...ef"
    }
  }
}
```

`command_sha256` is a lowercase 64-hex sha256 digest. The verifier computes
the digest in one of two ways, in priority order:

- If `command` resolves to a regular file on disk, hash the file contents.
  This is the strict mode — bit-for-bit identity of the binary or script the
  SDK will spawn.
- Otherwise (bare token like `node` / `python`, or path that does not exist)
  hash the UTF-8 bytes of the literal `command` string. This is a weak
  fallback that still detects tampering with the `.mcp.json` entry itself.

Enforcement is dual-path. Both paths read the same `.mcp.json` and the same
`security.pinned_mcp_servers` flag, so a config change takes effect on both
simultaneously:

- **SDK-side** — `src/providers/claude_code_local/mcp.ts::loadMcpServers`
  drops servers whose checksum mismatches and (when pinning is on) drops
  servers that declare no checksum. The drop emits a single-line warning on
  stderr naming the server.
- **Claude Code hook** — `.claude/hooks/mcp-policy.sh` runs as a `PreToolUse`
  hook for any tool whose name matches `mcp__.*`. It re-verifies the entry
  exists in `.mcp.json`, that a checksum is present under pinned mode, and
  that the file digest still matches. Exit 2 blocks the call with a clear
  message; the matcher is wired in `.claude/settings.json`.

The two paths are deliberately redundant. The SDK-side check governs runs
launched through Agent OS; the hook governs MCP tool calls that originate
inside the Claude Code CLI itself, including ad-hoc developer sessions that
never touch the Agent OS provider.

## Audit log

Every tool call writes a `tool_calls` row. The shape is intentionally
content-free — raw payloads live in the BlobStore as blobs addressed by their
hash:

| Column       | Meaning                                                                         |
| ------------ | ------------------------------------------------------------------------------- | ----------------- | ------- | ----- | -------------- |
| `tool`       | The tool id passed to the policy engine (e.g. `Read`, `mcp__filesystem__list`). |
| `risk`       | The resolved risk tag (`read                                                    | write             | network | shell | destructive`). |
| `decision`   | `allow                                                                          | approval_required | deny`.  |
| `rule`       | The policy rule that fired (`risk_levels`, `agent_allow`, `agent_approval`,     |
|              | `default_tool_policy`, `unknown_tool`).                                         |
| `latency_ms` | Wall-clock from tool dispatch to tool result.                                   |
| `args_ref`   | sha256 of the JSON-serialized arguments, stored in the BlobStore.               |
| `result_ref` | sha256 of the JSON-serialized result, stored in the BlobStore.                  |
| `error`      | Optional error message when the tool failed.                                    |

When `security.redact_secrets_in_logs: true` (the schema default), the auditor
runs a coarse redactor over `args` and `result` before blob-writing:

- object keys matching `/key|token|secret|password|auth|credential|bearer/i`
  have their values replaced with `<redacted>`;
- string values matching common vendor key shapes
  (`sk-…`, `AIza…`, `ghp_…`, `github_pat_…`, `xox[abprs]-…`, `Bearer …`) are
  scrubbed in-place.

This is Phase 4's coarse passlist. Phase 12 will move the rules into config
(PRD §2.5 — "allow-list of regex patterns configurable") and add deeper
content-aware scrubbing. With `redact_secrets_in_logs: false` the auditor
persists raw payloads — useful for local debugging when you trust the
workspace.

## What Phase 4 does NOT do (Phase 12 follow-ups)

The Phase 4 scope is deliberately tight. The following are tracked for
Phase 12:

- Configurable secret-redaction rules — Phase 4 ships a coarse passlist baked
  into the auditor; Phase 12 will move the patterns into `agent-os.config.yaml`.
- A sandboxed shell helper that confines `Bash` / `shell.exec` calls to the
  workspace and a vetted PATH.
- The full threat-model document (`docs/threat-model.md`), with attack-tree
  diagrams and per-component STRIDE notes.
- Signed manifests / provenance attestations for MCP servers beyond a
  content checksum.
- Codified hook integrity (signed hooks) so a contributor cannot silently
  weaken the PreToolUse policy.

## References

- PRD §1.7 — MCP & agent security.
- PRD §2.5 — security block in `agent-os.config.yaml`.
- PRD §2.6 — agent frontmatter (`tools.allowed`, `tools.approval_required`).
- PRD §2.7 — `.mcp.json` shape.
- PRD §3 Phase 4 — Tool / MCP permission layer.
- PRD §3 Phase 12 — Security hardening.
