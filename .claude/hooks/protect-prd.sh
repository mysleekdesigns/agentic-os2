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
#   .transcript_path            JSONL transcript file; we scan recent user
#                               turns for an allow-list trigger word.
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

# Claude Code PreToolUse JSON does not include the user prompt directly; it
# provides transcript_path (a JSONL file). Pull recent user-turn text out of
# the transcript and search it for an allow-list trigger word.
TRANSCRIPT=$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null || true)
PROMPT=""
if [ -n "$TRANSCRIPT" ] && [ -r "$TRANSCRIPT" ]; then
  # Scan the last 200 transcript lines, keep only user turns, and extract
  # their text. Content can be a plain string or an array of blocks with
  # `text` fields.
  PROMPT=$(tail -n 200 "$TRANSCRIPT" 2>/dev/null \
    | jq -r 'select(.type == "user") |
             (.message.content // .content // "") |
             if type == "string" then .
             elif type == "array" then (map(.text // "") | join(" "))
             else "" end' 2>/dev/null \
    | tail -n 20 | tr '\n' ' ' || true)
fi
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
