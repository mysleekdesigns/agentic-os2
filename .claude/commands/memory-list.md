---
description: List Agent OS memory entries (optionally filtered by scope)
---

Run the Agent OS CLI command `agent-os memory list --json` from the repository root, then summarise the entries (id, scope, key, agent, revision, updated_at, deleted) for the user in a short table. If the user supplied a scope name, append it as a positional argument (e.g. `agent-os memory list notes --json`). Forward any additional flags (such as `--all`, `--agent-id <id>`) verbatim. Use this when the user asks to "list memories", "show memory", "what memory entries exist", or similar.
