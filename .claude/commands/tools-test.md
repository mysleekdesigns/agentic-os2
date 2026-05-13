---
description: Dry-run the policy decision for a tool id (does not invoke the tool)
argument-hint: <tool-id>
---

Run the Agent OS CLI command `agent-os tools test <tool-id>` from the repository root and show the user the rendered verdict block. Forward any extra flags verbatim (`--json`, `--args <json>`, `--agent <id>`, `--auto-approve`). This is a DIAGNOSTIC: it reports what the runtime's policy engine would decide (`allow | approval_required | deny | unknown`) — it does NOT actually call the tool.
