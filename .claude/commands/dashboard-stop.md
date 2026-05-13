---
description: Stop the optional Agent OS local web dashboard
---

Run the Agent OS CLI command `agent-os dashboard stop` from the repository root. The command is idempotent: it exits 0 whether the dashboard is running, stopped, or has left a stale pidfile. Use this when the user asks to "stop the dashboard", "kill the web UI", or "shut down agent-os dashboard".
