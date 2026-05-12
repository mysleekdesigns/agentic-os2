---
name: next-phase
description: Implement the next incomplete phase of PRD.md using a team of parallel agents, run the surface-specific auditor subagents and the verify-no-api-key quality gate, mark the phase complete in PRD.md, then commit and push. Trigger when the user asks to "do the next phase", "run next-phase", "implement next phase of PRD", or invokes /next-phase.
---

# next-phase — parallel-agent PRD phase runner

You are orchestrating a phase of work defined in `PRD.md`. Follow these steps in order. Do not skip steps. Do not ask clarifying questions — make the reasonable call and continue.

The repo ships a small set of project-specific subagents, skills, and hooks under `.claude/`. They are not optional add-ons — they encode the PRD's invariants (deny-by-default tools, §2.4 schema shape, honest provider capabilities, no-API-key quality bar). Use them as called out in the steps below.

## Step 1 — Identify the next phase

1. Read `PRD.md` from the repo root.
2. Locate section `## 3. Phased Implementation Plan`.
3. Find the **first** phase whose heading is NOT marked `✅ COMPLETE`. Phases look like `### Phase N — <Title>`.
4. Extract: the phase number, title, outcome, the full checklist (every `- [ ]` item), and the **Exit** criteria.
5. State to the user in one sentence which phase you're starting (e.g. "Starting Phase 1 — Storage & config layer").

If every phase is already complete, tell the user and stop.

For unusually large or cross-cutting phases (e.g. Phase 5 orchestrator, Phase 11 API providers), you MAY first delegate to the `prd-phase-planner` subagent to produce a file-level plan before decomposing. Skip this for small phases — it just burns context.

## Step 2 — Map the phase to auditors and scaffolding

Before decomposing, build a 3-line mental map of which `.claude/` artifacts apply to this phase. Use the **surface rules** below — match by the file paths and PRD sections the phase touches, not by phase number.

**Auditor subagents** (read-only reviewers, run after implementation, before marking complete):

| If the phase touches…                                                      | Run this subagent                    |
| -------------------------------------------------------------------------- | ------------------------------------ |
| `src/storage/`, Drizzle schema, migrations, PRD §2.4 tables                | `drizzle-schema-reviewer`            |
| `src/providers/`, `src/core/providers/`, PRD §2.2 / Phase 3 / Phase 11     | `provider-capability-auditor`        |
| `.mcp.json`, `src/core/tools/`, `src/security/`, agent tool allowlists,    | `mcp-security-auditor`               |
| `.claude/hooks/`, `agent-os.config.yaml` `security.*`, PRD §1.7 / Phase 12 |                                      |
| `agents/`, `agents/templates/`, new agent definitions (PRD §2.6, Phase 2)  | `eval-fixture-author` (writes evals) |
| `evals/fixtures/`, PRD §1.6 / Phase 9                                      | `eval-fixture-author`                |

If more than one applies, all of them run in Step 5 — in parallel.

**Scaffolding skills** (available to the parallel bundles in Step 4, NOT invoked here):

| If a bundle is doing…                                        | The bundle may invoke this skill |
| ------------------------------------------------------------ | -------------------------------- |
| New Drizzle schema/migration work                            | `/add-migration`                 |
| Authoring a new agent definition (canonical + mirror + eval) | `/add-agent-template`            |
| Adding an `agent-os` CLI subcommand                          | `/add-cli-command`               |
| Wiring a Provider adapter                                    | `/add-provider`                  |

Note this map to yourself in 3 lines (no .md file). Carry the list of auditor subagents into Step 5.

## Step 3 — Plan the parallel decomposition

Group the phase's checklist items into 2–4 **independent** work bundles that can run in parallel without stepping on each other's files. Use these heuristics:

- Schema/types in their own bundle (so other bundles can import the types).
- Tests in their own bundle so they can be written against the contracts of the other bundles.
- Group items that touch the same files into the same bundle.
- If items are strongly sequential (B needs A's output), keep them in the same bundle and order them inside it.

Write a brief plan (3–6 lines) listing each bundle and what it owns. This is a status message to the user, not a planning document — do not create a planning .md file.

## Step 4 — Spawn the team in parallel

Send a SINGLE message with multiple `Agent` tool calls (one per bundle) so they run concurrently. Use `subagent_type: "general-purpose"` for each. Each prompt MUST be self-contained — the subagent has no memory of this conversation.

Each subagent prompt must include:

- The repo root: `/Users/simonlacey/Documents/GitHub/agentic-os2`
- The phase number, title, and outcome from PRD.md
- The exact checklist items this bundle owns (verbatim from PRD)
- The relevant architecture notes from PRD §2 (data model, config shape, repo layout — quote the slices that matter for this bundle)
- "Existing stack: TypeScript, Node 20+, Vitest. Match the conventions in `src/` and `tests/`. Run `npm run typecheck`, `npm run lint`, and `npm test` before reporting done."
- "Scaffolding skills available inside this bundle: `/add-migration`, `/add-agent-template`, `/add-cli-command`, `/add-provider`. Invoke one ONLY if your bundle's work is exactly what its description matches — do not force-fit. Each skill produces files under conventional paths from PRD §2.3."
- "Hooks active in this repo (`.claude/settings.json`): a `PostToolUse` hook runs Prettier on every TS/JSON/YAML/MD edit automatically — do not run `npm run format` manually. A `PreToolUse` hook blocks destructive bash (`rm -rf`, `git push --force`, `git reset --hard`); avoid those commands. A `PreToolUse` hook blocks edits to `PRD.md` from this bundle — do not edit PRD.md, the orchestrator does that."
- "Do NOT modify PRD.md. Do NOT git commit. Just implement and verify your bundle."
- "Report back: files created/modified, any deviations from the checklist, the final results of typecheck/lint/test, and any skill invocations you made."

Give each Agent call a `name` so you can refer to them in the recap (e.g. `name: "phase1-storage"`).

## Step 5 — Reconcile, audit, and verify

After all subagents return:

1. Read each agent's report.
2. If any agent reported a failure, decide: fix it yourself in the main thread (small fix) or re-dispatch to a fresh Agent with a focused prompt (larger fix). Do not mark a phase complete on a failed bundle.
3. Run the full verification suite yourself from the repo root:
   - `npm run typecheck`
   - `npm run lint`
   - `npm test`
4. If any of those fail, fix the failures (directly or via another Agent) before continuing.
5. **Run the auditor subagent(s) you identified in Step 2.** Send them in a single parallel batch when multiple apply. Each will return a verdict (`PASS`, `PASS WITH NITS`, `BLOCK`). For any `BLOCK`, fix the cited findings and re-run that auditor. `PASS WITH NITS` does not block the phase — record the nits in the commit body as known-followup.
6. **Run the `/verify-no-api-key` skill.** This is the PRD §4 quality bar ("works locally with no API key"); it is non-negotiable. If it returns FAIL, fix the cause (usually a code path reading `ANTHROPIC_API_KEY` or hardcoding `anthropic_api` as the provider) before continuing.

Only move on when typecheck/lint/test are green, every applicable auditor PASSes (with or without nits), and `verify-no-api-key` is PASS.

## Step 6 — Update PRD.md

Once everything is green:

1. Edit `PRD.md` to mark the phase complete. Match the exact format used by Phase 0:
   - Change the heading from `### Phase N — <Title>` to `### Phase N — <Title> ✅ COMPLETE (<today's date in YYYY-MM-DD>)`.
   - Change every `- [ ]` in that phase to `- [x]`.
   - Replace the `**Exit**:` line with `**Exit (met)**:` and append a short factual note about how it was met (e.g. test counts, key files, commands that pass, auditor verdicts).
   - Add an `**Artifacts shipped**:` line listing the new/modified files (mirrors Phase 0's style).
2. If the phase has corresponding items in `## 7. Deliverables checklist`, tick those `- [ ]` → `- [x]`.

The `protect-prd.sh` PreToolUse hook permits these edits because the active user prompt mentions "phase" (an allow-list trigger). No special handling needed.

## Step 7 — Commit and push

Use the existing branch (`development` per `git status` at session start, but check current branch with `git branch --show-current`). Then in parallel:

- `git add -A` (scoped to the modified files — prefer naming them explicitly over `-A` if the change set is small and clean)
- `git status` to confirm what's staged

Then sequentially:

Run this commit command verbatim, with no leading indentation on any line of the HEREDOC body:

```bash
git commit -m "$(cat <<'EOF'
Complete Phase <N>: <Title>

<1–3 line summary of what shipped>

Auditors: <list each applicable auditor and its verdict>
verify-no-api-key: PASS

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Then push to the current branch's upstream:

```bash
git push
```

If no upstream is set, use `git push -u origin <current-branch>` instead.

If the pre-commit hook fails, fix the issue and create a NEW commit (never `--amend`, never `--no-verify`).

Reminder: `block-destructive-bash.sh` will refuse `git push --force`, `git reset --hard`, `git branch -D`, and recursive `chmod -R` / `chown -R`. Don't use them; if you think you need to, stop and ask the user instead.

## Step 8 — Report

End with a 2–3 sentence summary: which phase shipped, which bundles ran, which auditors verdicted, and what the next phase will be (read PRD.md again to name it).

## Guardrails

- Never modify PRD.md until Step 6 (after green tests AND green audits AND `verify-no-api-key` PASS).
- Never commit broken code. If you can't make it green, stop and tell the user what's blocking.
- Never skip a checklist item silently — if you intentionally defer one, call it out in the commit message and leave its `- [ ]` unticked.
- Never skip an applicable auditor. The mapping in Step 2 is the rule; if the surface matches, the auditor runs.
- Never skip `verify-no-api-key`. It is the §4 quality bar.
- Never push to `main` directly. If the current branch is `main`, stop and ask before pushing.
- One phase per invocation. Do not loop into the next phase automatically.

```

```
