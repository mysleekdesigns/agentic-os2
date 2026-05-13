---
description: Run an Agent OS workspace health check (config, providers, MCP, database)
---

Run the Agent OS CLI command `agent-os doctor --json` from the repository root, then summarise for the user: workspace status, config sections (default_provider, security, approvals), each provider's enabled/api-key status, MCP server health, database migrations applied / last migration, agent-os and node versions, and any warnings. Forward additional flags (e.g. plain `agent-os doctor` for pretty output) if the user prefers. Use this when the user asks to "run doctor", "health check", "what's my config", or "is agent-os set up correctly".
