---
description: Search Agent OS memory entries by query
---

Run the Agent OS CLI command `agent-os memory search "<query>" --json` from the repository root, substituting `<query>` with the user's search string (quote it to preserve spaces). Forward optional flags verbatim: repeatable `--scope <name>` filters, `--top-k <n>` (defaults to 10), `--agent-id <id>` (enforces per-agent memory.read policy). Summarise the results as `<score>  <scope>:<key> — <snippet>` lines for the user. Use this when the user asks to "search memory", "find memories about X", "look up <topic> in memory", or similar.
