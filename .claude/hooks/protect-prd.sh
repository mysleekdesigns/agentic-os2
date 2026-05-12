#!/usr/bin/env bash
# PreToolUse hook for Edit/Write. Blocks edits to PRD.md unless the
# triggering user prompt explicitly mentions PRD/phase/scope changes.
#
# Rationale: PRD.md is the canonical scope document for this project.
# Drive-by edits during unrelated work are almost always wrong — the
# `next-phase` skill is the one path that legitimately edits PRD.md
# (it marks phases complete). Everything else should require an
# explicit user ask.
#
# Inputs (PreToolUse JSON on stdin):
#   .tool_name                  "Edit" or "Write"
#   .tool_input.file_path       target absolute path
#   .session.user_prompt        the most recent user prompt text (best-effort)
#
# Exit 2 blocks the call.

set -euo pipefail

INPUT=$(cat)
FILE=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null || true)

# Only fire when the target is PRD.md at the repo root.
case "$FILE" in
  */agentic-os2/PRD.md|*/PRD.md)
    ;;
  *)
    exit 0
    ;;
esac

PROMPT=$(printf '%s' "$INPUT" | jq -r '.session.user_prompt // .user_prompt // empty' 2>/dev/null || true)
PROMPT_LC=$(printf '%s' "$PROMPT" | tr '[:upper:]' '[:lower:]')

# Allow when:
#   - user prompt mentions PRD or scope changes
#   - the change is part of next-phase (marking a phase complete)
case "$PROMPT_LC" in
  *prd*|*scope*|*phase*|*"mark complete"*|*"mark phase"*|*"update prd"*|*"edit prd"*)
    exit 0
    ;;
esac

printf '%s\n' "BLOCKED by .claude/hooks/protect-prd.sh: edit to PRD.md without explicit ask." >&2
printf '%s\n' "PRD.md is the canonical scope doc. If this is intentional, re-prompt mentioning 'PRD' or 'phase'." >&2
exit 2
