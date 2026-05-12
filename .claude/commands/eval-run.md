---
description: Run Agent OS eval fixtures and persist a run report
argument-hint: '[fixture-or-dir] [flags]'
---

Run the Agent OS CLI command `agent-os eval run $ARGUMENTS` from the repository root. The first argument is an optional fixture file or directory path (defaults to `<workspaceRoot>/evals/fixtures`). Forward any additional flags (such as `--json`, `--provider`, `--model`, `--enable-model-graded`) verbatim. The command persists each fixture result to `eval_results` and snapshots the full report to `.agent-os/eval-runs/<runId>.json` for later diffing.
