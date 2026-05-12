# Agent OS

A local-first, Claude Code Max–compatible developer operating layer for
creating, coordinating, observing, securing, evaluating, and improving AI
agents. Agent OS builds on top of Claude Code's native subagent, hook, and MCP
primitives and adds a provider-pluggable runtime so the same agent definitions
can run locally against a Claude Code Max login (no API key) or, when
configured, against hosted Anthropic or OpenAI APIs.

## Status

Phase 0 — foundations complete. See [`PRD.md`](./PRD.md) for the full plan.

## Quickstart

```sh
npm install
npm test
npm run build
node dist/cli/index.js --version
```

The CLI binary lives at `dist/cli/index.js` after `npm run build`. After
running `npm link`, the binary is also available on your `PATH` as
`agent-os`, so `npx agent-os --version` (or just `agent-os --version`) works
as well.

## Documentation

- [`PRD.md`](./PRD.md) — full product requirements document, research summary,
  architecture, and phased implementation plan.
- [`docs/architecture.md`](./docs/architecture.md) — architecture overview and
  high-level diagram.
- [`docs/decisions/`](./docs/decisions/) — architecture decision records
  (ADRs). Start with [`0001-stack.md`](./docs/decisions/0001-stack.md).
