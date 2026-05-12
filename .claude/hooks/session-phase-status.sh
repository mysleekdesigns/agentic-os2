#!/usr/bin/env bash
# SessionStart hook. Adds a short reminder of the current PRD phase status
# as additionalContext so Claude knows, on day one of a session, which
# phase is next and what its exit criterion is.
#
# Output (stdout JSON, per Claude Code hook contract):
#   { "hookSpecificOutput": { "additionalContext": "...short text..." } }
#
# Non-blocking. If PRD.md is missing or unreadable, we emit nothing.

set -euo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
PRD="$PROJECT_DIR/PRD.md"

if [ ! -r "$PRD" ]; then
  exit 0
fi

# Find the first phase heading that does NOT already have ✅ COMPLETE on it.
NEXT_PHASE_LINE=$(grep -E '^### Phase [0-9]+ — ' "$PRD" | grep -v '✅ COMPLETE' | head -n 1 || true)

if [ -z "$NEXT_PHASE_LINE" ]; then
  CONTEXT="PRD.md: every phase is marked ✅ COMPLETE. Likely time to ship or open the next PRD."
else
  # Strip the leading '### '.
  NEXT_PHASE=$(printf '%s' "$NEXT_PHASE_LINE" | sed -E 's/^### //')
  CONTEXT="Agent OS — next incomplete phase per PRD.md: ${NEXT_PHASE}. Run \`/next-phase\` to start it, or \`/prd-phase-planner\` (subagent) for a file-level plan first."
fi

# Emit the JSON output Claude Code expects. Escape quotes/newlines via jq.
jq -n --arg ctx "$CONTEXT" '{ hookSpecificOutput: { additionalContext: $ctx } }'
exit 0
