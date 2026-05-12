#!/usr/bin/env bash
# PreToolUse hook for Bash. Blocks destructive shell commands by default.
# Receives the PreToolUse JSON on stdin; exit 2 blocks the call and sends
# stderr to Claude. The matcher in settings.json narrows this hook to Bash
# tool calls so we don't pay the jq startup cost for every tool.
#
# Blocks:
#   rm -rf <anything>                (irreversible deletes)
#   git push --force / -f             (rewriting upstream history)
#   git reset --hard                  (discarding uncommitted work)
#   git branch -D                     (force-delete local branches)
#   chmod -R / chown -R               (recursive permission changes)
#   dd if=... of=...                  (raw device writes)
#
# This is a project-scoped safety net. The user can override by editing the
# allow-list at the bottom of this file or by deleting this hook.

set -euo pipefail

INPUT=$(cat)
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)

if [ -z "$CMD" ]; then
  exit 0
fi

block() {
  local reason="$1"
  printf '%s\n' "BLOCKED by .claude/hooks/block-destructive-bash.sh: $reason" >&2
  printf '%s\n' "Edit .claude/hooks/block-destructive-bash.sh or run the command manually if this is intended." >&2
  exit 2
}

case "$CMD" in
  *"rm -rf "*|*"rm -fr "*|*"rm --recursive --force"*)
    block "destructive rm -rf"
    ;;
  *"git push --force"*|*"git push -f "*|*"git push --force-with-lease"*)
    # --force-with-lease is safer; warn but still block at the project level — the user
    # can confirm explicitly. Remove this clause if you trust --force-with-lease.
    block "force push to remote"
    ;;
  *"git reset --hard"*)
    block "git reset --hard discards uncommitted work"
    ;;
  *"git branch -D "*)
    block "force-delete local branch"
    ;;
  *"chmod -R"*|*"chown -R"*)
    block "recursive permission/ownership change"
    ;;
  *"dd if="*"of="*)
    block "raw dd write"
    ;;
  *":(){ :|:& };:"*|*"fork bomb"*)
    block "fork bomb pattern"
    ;;
esac

exit 0
