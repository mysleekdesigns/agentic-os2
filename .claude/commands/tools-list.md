---
description: List tools known to the Agent OS tool registry
---

Run the Agent OS CLI command `agent-os tools list` from the repository root and show the user the rendered table. If the user passes a flag (such as `--json` or `--agent <id>`), forward it verbatim. The command is read-only — it merely surfaces the in-memory tool registry plus, when `--agent` is given, the union of that agent's `tools.allowed` and `tools.approval_required`.
