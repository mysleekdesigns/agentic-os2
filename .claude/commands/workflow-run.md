---
description: Run an Agent OS workflow end-to-end and stream its events
---

Run the Agent OS CLI command `agent-os workflow run $ARGUMENTS` from the repository root. The first argument is the workflow id (see `agent-os workflow list`). Forward any additional flags (such as `--json`, or repeated `--input key=value`) verbatim. Stream the resulting events to the user. If the workflow pauses (approval or wait_event), surface the printed `run_id` and remind the user they can resume with `agent-os workflow resume <run-id>`.
