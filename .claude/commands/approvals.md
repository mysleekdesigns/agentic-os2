---
description: Umbrella for the Agent OS approvals slash commands
---

Agent OS exposes four approval subcommands. Pick the appropriate one based on the user's intent and run it directly:

- `/approvals-list` — list pending (or all) approval requests.
- `/approvals-show <id>` — show details of a single approval request.
- `/approvals-approve <id>` — approve a pending request.
- `/approvals-reject <id>` — reject a pending request.

If the user did not specify, default to `/approvals-list`. You can always invoke the CLI directly: `agent-os approvals <list|show|approve|reject> [args] --json`.
