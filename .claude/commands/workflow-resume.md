---
description: Resume a paused Agent OS workflow run
---

Run the Agent OS CLI command `agent-os workflow resume <run-id>` from the repository root, substituting `<run-id>` with the run id the user provided. Stream the resulting events to the user. Forward any additional flags (such as `--json`) verbatim. Use this when the user asks to "resume the workflow", "continue the paused run", or similar after an approval / wait_event pause.
