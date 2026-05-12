# ADR 0001: TypeScript on Node 20+ as the implementation stack

- **Status**: Accepted
- **Date**: 2026-05-12

## Context

Agent OS is being built as a local-first developer layer on top of Claude Code
Max. The two SDKs that sit at the center of the system — the Claude Agent SDK
(`@anthropic-ai/claude-agent-sdk`) and the Model Context Protocol SDK — both
have first-class TypeScript support, with Python parity lagging at the time of
writing. The repository already declares a Node-based MCP server in `.mcp.json`
(`crawlforge-mcp-server/server.js`), so a working Node toolchain is a hard
prerequisite regardless of any other language choice. Claude Code itself,
which is the primary runtime target, is a Node CLI. See PRD §1.8 for the full
research note.

## Decision

The implementation language is **TypeScript on Node 20+**. Bun is supported
opportunistically where it is drop-in compatible, but Node is the reference
runtime and the only one CI must guarantee. Users who prefer Python drive the
system through the `agent-os` CLI; no Python runtime is required to build,
extend, or run Agent OS.

## Consequences

- **+** Direct ecosystem alignment with the Claude Agent SDK and MCP SDK —
  fewer adapters, fewer surprises, faster upgrades.
- **+** A single language across the CLI, provider adapters, MCP integrations,
  and (eventually) the optional web dashboard. Shared schemas (Zod) and shared
  types end-to-end.
- **−** No first-class access to Python-native scientific/ML tooling from
  inside the core. Acceptable trade-off: agents can shell out to Python via
  sandboxed shell tools when needed.
- **−** Slightly heavier runtime footprint than a Bun-only stack, but
  significantly more portable across developer machines and CI environments.

## Alternatives considered

- **Python.** Rejected. MCP SDK parity and Claude Agent SDK ergonomics in
  Python were materially behind TypeScript at the time of decision, and the
  existing repo already pulls in a Node MCP server.
- **Bun-only.** Rejected as the *sole* runtime due to portability and
  ecosystem maturity concerns (native module compatibility, CI availability,
  Windows support). Bun remains a supported opportunistic runtime.
- **Go.** Rejected. No first-class Claude Agent SDK; would require maintaining
  a hand-rolled client and re-implementing MCP, which is squarely off-mission
  for an integration-focused project.
