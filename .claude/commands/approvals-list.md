---
description: List Agent OS approval requests in the queue
---

Run the Agent OS CLI command `agent-os approvals list --json` from the repository root, then summarise the pending approvals (id, status, run_id, action, requested_by, requested_at, expires_in) for the user in a short table. If the user passes additional flags (such as `--all`), forward them verbatim. Use this when the user asks to "list approvals", "show pending approvals", or "what approvals are waiting".
