---
description: Umbrella for the Agent OS memory slash commands
---

Agent OS exposes four memory subcommands. Pick the appropriate one based on the user's intent and run it directly:

- `/memory-list [scope]` — list memory entries (optionally filtered by scope).
- `/memory-show <id|scope:key>` — show a single memory entry's details.
- `/memory-search <query>` — semantic / lexical search across memory entries.
- `/memory-write <scope> <key> <value>` — create or update a memory entry.

If the user did not specify, default to `/memory-list`. You can always invoke the CLI directly: `agent-os memory <list|show|search|write> [args] --json`.
