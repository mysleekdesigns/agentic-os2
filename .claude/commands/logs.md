---
description: Show recent Agent OS workspace events (logs), reverse-chronological
---

When the user asks to "show logs", "show recent events", "what happened recently", or wants to inspect workspace events: run the Agent OS CLI command `agent-os logs --json` from the repository root. If the user specifies filters such as an agent id ("show logs for agent X"), a time window ("in the last hour", "since 5m"), an event kind ("memory.denied"), or a limit, translate them into the CLI flags (`--agent`, `--since`, `--kind`, `--limit`) and append them to the command. Summarise the resulting JSONL stream for the user. Note that `--follow` is not yet supported.
