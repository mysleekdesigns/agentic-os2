---
name: all-phases
description: Run /next-phase repeatedly until every phase in PRD.md is marked ✅ COMPLETE. Trigger when the user asks to "ship all phases", "complete all phases", "run next-phase in a loop", "finish the PRD end-to-end", or invokes /all-phases. Each iteration invokes the existing /next-phase skill (impl → tests → auditors → /verify-no-api-key → PRD update → commit → push) and verifies the phase actually shipped before continuing. Halts on first failure.
---

# all-phases — autonomous loop over /next-phase

You are an autonomous orchestrator. Run `/next-phase` once per incomplete phase, until every phase in `PRD.md` is marked `✅ COMPLETE`. Do NOT ask clarifying questions — make the reasonable call and continue. The user has authorized continuous operation across phases.

The `/next-phase` skill already enforces the full per-phase pipeline (parallel impl bundles, typecheck/lint/test, auditor subagents, `/verify-no-api-key`, PRD update, commit, push). This skill just iterates it and verifies each step really shipped.

## Step 1 — Pre-flight

Before starting the loop:

1. `git branch --show-current` — must NOT be `main`. If `main`, stop and tell the user. Pushing this many commits to `main` directly is unsafe.
2. `git status --short` — note any untracked or modified files. Acceptable: untracked dirs the next phase will own (e.g. `src/core/tools/`). Unacceptable: dirty tracked files unrelated to the next phase. If unexpectedly dirty, stop and report.
3. `git rev-parse @{u} 2>/dev/null` — the current branch must have an upstream. Without one, `/next-phase`'s push step will fail. If missing, stop and tell the user to set it (`git push -u origin <branch>`).
4. Count phases:
   ```bash
   total=$(grep -c "^### Phase " PRD.md)
   done=$(grep -c "^### Phase .*✅ COMPLETE" PRD.md)
   remaining=$((total - done))
   ```
   If `remaining == 0`, tell the user "all phases already complete" and stop.
5. State to the user in one line: "Starting all-phases loop. <remaining> incomplete phases. Halts on first failure or after 20 iterations."

## Step 2 — The loop

Repeat until either (a) no incomplete phases remain, or (b) a phase fails its post-check, or (c) you hit the 20-iteration safety cap.

### 2a. Identify the next phase

Read `PRD.md`. Find the first `### Phase N — Title` line **without** `✅ COMPLETE`. Capture `N` and `Title`. If none, exit the loop with success and go to Step 3.

### 2b. Snapshot pre-state

Before invoking `/next-phase`, record:

- `git rev-parse HEAD` (call it `HEAD_BEFORE`)
- The current incomplete phase heading line verbatim

You'll compare against these after the phase runs.

### 2c. Invoke /next-phase

Invoke the `Skill` tool with `skill: "next-phase"`. Let it run to completion. Do not interrupt it. Do not second-guess its auditor verdicts or test runs — `/next-phase` already gates on green tests, green auditors, and a green `/verify-no-api-key` before committing.

### 2d. Post-check (this is the source of truth — don't skip)

After `/next-phase` returns, run all four checks. Any failure halts the loop:

1. **PRD heading flipped.** Re-read `PRD.md`. The phase you snapshotted must now end in `✅ COMPLETE (<date>)`. If not → halt.
2. **HEAD advanced.** `git rev-parse HEAD` must differ from `HEAD_BEFORE`. If not → halt (the skill didn't commit).
3. **Working tree clean.** `git status --short` must be empty. If not → halt (the skill left uncommitted work).
4. **Push landed.** `git rev-parse HEAD` must equal `git rev-parse @{u}`. If the upstream is behind → halt (the push silently failed).

If all four pass, emit one line to the user: `✅ Phase <N> shipped (<short-sha>) — <Title>`. Continue the loop.

### 2e. Safety cap

Hard-cap at 20 iterations. The PRD has fewer phases than this; if you hit 20 without the loop exiting on its own, something is wrong (likely a post-check is failing to detect non-progress). Halt and report.

## Step 3 — Final report

When the loop exits, give a compact summary (≤15 lines):

- Phases shipped this run, in order: `Phase N — Title (<sha>)`
- The phase the loop halted on, if any, with the failing post-check and the last few lines of relevant output
- `git branch --show-current` and `git rev-parse --short HEAD`
- Whether `PRD.md` now shows zero incomplete phases

## Guardrails

- **Never** run two `/next-phase` invocations concurrently. Phases are sequential by design (each builds on the prior) and they share the working tree.
- **Never** skip a post-check. The PRD heading flip and the HEAD advance are the only honest signals that a phase actually shipped.
- **Never** edit `PRD.md` from this orchestrator — `/next-phase` does that. The `protect-prd.sh` PreToolUse hook permits it only because the active prompt contains "phase".
- **Never** retry or skip a failed phase automatically. A failure usually means real signal (broken test, blocking auditor finding, rejected push) that the user needs to see. Halt, report, let the user fix and re-invoke.
- **Never** use `--amend`, `--force`, `--no-verify`, or `reset --hard`. `block-destructive-bash.sh` will refuse them anyway.
- **Never** run on `main`. Stop in pre-flight.
- **One invocation per phase.** Do not call `/next-phase` twice in the same iteration "to be sure".
