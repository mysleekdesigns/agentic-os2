#!/usr/bin/env bash
# PostToolUse hook for Edit/Write. Best-effort formats edited TypeScript
# files with Prettier so the working tree stays consistent without the
# agent having to remember to run `npm run format` after every change.
#
# Non-blocking: exit 0 always. If prettier is missing or fails, we just
# move on — formatting is a convenience, not a gate.

set -euo pipefail

INPUT=$(cat)
FILE=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null || true)

# Only TS/TSX/JS/MJS/CJS/JSON/YAML/MD under the project.
case "$FILE" in
  *.ts|*.tsx|*.js|*.mjs|*.cjs|*.json|*.yaml|*.yml|*.md)
    ;;
  *)
    exit 0
    ;;
esac

# Skip files outside the project root.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
case "$FILE" in
  "$PROJECT_DIR"/*) ;;
  *) exit 0 ;;
esac

# Prefer the project-local prettier so we use the version pinned in package.json.
PRETTIER="$PROJECT_DIR/node_modules/.bin/prettier"
if [ ! -x "$PRETTIER" ]; then
  # No local prettier; do nothing — don't fight the environment.
  exit 0
fi

# Best-effort format. Discard output so we don't spam Claude's context.
"$PRETTIER" --write --log-level silent "$FILE" >/dev/null 2>&1 || true
exit 0
