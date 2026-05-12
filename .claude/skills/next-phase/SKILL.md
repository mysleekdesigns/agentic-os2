---
name: next-phase
description: Implement the next incomplete phase of PRD.md using a team of parallel agents, run tests, mark the phase complete in PRD.md, then commit and push. Trigger when the user asks to "do the next phase", "run next-phase", "implement next phase of PRD", or invokes /next-phase.
---

# next-phase — parallel-agent PRD phase runner

You are orchestrating a phase of work defined in `PRD.md`. Follow these steps in order. Do not skip steps. Do not ask clarifying questions — make the reasonable call and continue.

## Step 1 — Identify the next phase

1. Read `PRD.md` from the repo root.
2. Locate section `## 3. Phased Implementation Plan`.
3. Find the **first** phase whose heading is NOT marked `✅ COMPLETE`. Phases look like `### Phase N — <Title>`.
4. Extract: the phase number, title, outcome, the full checklist (every `- [ ]` item), and the **Exit** criteria.
5. State to the user in one sentence which phase you're starting (e.g. "Starting Phase 1 — Storage & config layer").

If every phase is already complete, tell the user and stop.

## Step 2 — Plan the parallel decomposition

Group the phase's checklist items into 2–4 **independent** work bundles that can run in parallel without stepping on each other's files. Use these heuristics:

- Schema/types in their own bundle (so other bundles can import the types).
- Tests in their own bundle so they can be written against the contracts of the other bundles.
- Group items that touch the same files into the same bundle.
- If items are strongly sequential (B needs A's output), keep them in the same bundle and order them inside it.

Write a brief plan (3–6 lines) listing each bundle and what it owns. This is a status message to the user, not a planning document — do not create a planning .md file.

## Step 3 — Spawn the team in parallel

Send a SINGLE message with multiple `Agent` tool calls (one per bundle) so they run concurrently. Use `subagent_type: "general-purpose"` for each. Each prompt MUST be self-contained — the subagent has no memory of this conversation.

Each subagent prompt must include:

- The repo root: `/Users/simonlacey/Documents/GitHub/agentic-os2`
- The phase number, title, and outcome from PRD.md
- The exact checklist items this bundle owns (verbatim from PRD)
- The relevant architecture notes from PRD §2 (data model, config shape, repo layout — quote the slices that matter for this bundle)
- "Existing stack: TypeScript, Node 20+, Vitest. Match the conventions in `src/` and `tests/`. Run `npm run typecheck`, `npm run lint`, and `npm test` before reporting done."
- "Do NOT modify PRD.md. Do NOT git commit. Just implement and verify your bundle."
- "Report back: files created/modified, any deviations from the checklist, and the final results of typecheck/lint/test."

Give each Agent call a `name` so you can refer to them in the recap (e.g. `name: "phase1-storage"`).

## Step 4 — Reconcile and verify

After all subagents return:

1. Read each agent's report.
2. If any agent reported a failure, decide: fix it yourself in the main thread (small fix) or re-dispatch to a fresh Agent with a focused prompt (larger fix). Do not mark a phase complete on a failed bundle.
3. Run the full verification suite yourself from the repo root:
   - `npm run typecheck`
   - `npm run lint`
   - `npm test`
4. If any of those fail, fix the failures (directly or via another Agent) before continuing.

## Step 5 — Update PRD.md

Once everything is green:

1. Edit `PRD.md` to mark the phase complete. Match the exact format used by Phase 0:
   - Change the heading from `### Phase N — <Title>` to `### Phase N — <Title> ✅ COMPLETE (<today's date in YYYY-MM-DD>)`.
   - Change every `- [ ]` in that phase to `- [x]`.
   - Replace the `**Exit**:` line with `**Exit (met)**:` and append a short factual note about how it was met (e.g. test counts, key files, commands that pass).
   - Add an `**Artifacts shipped**:` line listing the new/modified files (mirrors Phase 0's style).
2. If the phase has corresponding items in `## 7. Deliverables checklist`, tick those `- [ ]` → `- [x]`.

## Step 6 — Commit and push

Use the existing branch (`development` per `git status` at session start, but check current branch with `git branch --show-current`). Then in parallel:

- `git add -A` (scoped to the modified files — prefer naming them explicitly over `-A` if the change set is small and clean)
- `git status` to confirm what's staged

Then sequentially:

- `git commit -m "$(cat <<'EOF'
Complete Phase <N>: <Title>

<1–3 line summary of what shipped>

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"`
- `git push` (push to the current branch's upstream; if no upstream is set, use `git push -u origin <current-branch>`)

If the pre-commit hook fails, fix the issue and create a NEW commit (never `--amend`, never `--no-verify`).

## Step 7 — Report

End with a 2–3 sentence summary: which phase shipped, which bundles ran, and what the next phase will be (read PRD.md again to name it).

## Guardrails

- Never modify PRD.md until Step 5 (after green tests).
- Never commit broken code. If you can't make it green, stop and tell the user what's blocking.
- Never skip a checklist item silently — if you intentionally defer one, call it out in the commit message and leave its `- [ ]` unticked.
- Never push to `main` directly. If the current branch is `main`, stop and ask before pushing.
- One phase per invocation. Do not loop into the next phase automatically.
