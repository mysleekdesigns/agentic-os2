---
description: Diff two persisted Agent OS eval run reports
argument-hint: '<run-a> <run-b> [--json]'
---

Run the Agent OS CLI command `agent-os eval diff $ARGUMENTS` from the repository root. The two positional arguments are run ids previously emitted by `agent-os eval run`; the command reads their snapshots from `.agent-os/eval-runs/<runId>.json` and reports fixture-level status (regressed / recovered / changed / added / removed). Exit code is non-zero when any fixture regressed. Forward `--json` verbatim if requested.
