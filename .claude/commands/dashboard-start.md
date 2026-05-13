---
description: Start the optional Agent OS local web dashboard (Phase 15)
---

Run the Agent OS CLI command `agent-os dashboard start` from the repository root. Defaults bind the Next.js server to `127.0.0.1:3030`. Forward `--host`, `--port`, or `--dev` flags if the user provides them. If the user wants to bind to a non-loopback host, remind them to set `AGENT_OS_DASHBOARD_TOKEN` (generated via `openssl rand -hex 32`). Use this when the user asks to "start the dashboard", "open the web UI", or "launch the agent-os dashboard".
