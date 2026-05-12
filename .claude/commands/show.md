---
description: Show the timeline of an Agent OS run (workflow or agent) by run id — spans, steps, and pending approvals
---

When the user asks to "show a run", "show timeline", "what happened in run X", or otherwise references a run id and wants details: run the Agent OS CLI command `agent-os show <run-id> --json` from the repository root, substituting `<run-id>` with the run id the user provided. Parse the JSON payload and summarise the run header, the span tree (if `traces` is non-empty), the step list, and any pending approvals. If the user passes additional flags (such as `--no-spans` or `--no-color`), forward them verbatim and re-run without `--json` so the user sees the human-readable rendering.
