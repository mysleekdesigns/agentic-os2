#!/usr/bin/env bash
# PreToolUse policy hook — generic destructive-class safety net.
#
# Phase 12 / PRD §2.5: this is the hook that "ties everything together" for
# Claude Code native runs. It mirrors the small subset of the TS policy engine
# (`src/core/tools/policy.ts`) that is expressible in shell — specifically the
# hardest-priority rule: `risk_levels.destructive: deny` wins over every
# allow-list.
#
# Why coarse-grained?
# - Claude Code's own approval UI handles per-tool prompts.
# - `.claude/hooks/block-destructive-bash.sh` already covers `Bash` specifics
#   (rm -rf, git push --force, …).
# - `.claude/hooks/mcp-policy.sh` already covers `mcp__*` server pinning.
# - The SDK-side interceptor in `src/core/tools/interceptor.ts` runs the full
#   policy engine for programmatic runs.
# This hook therefore only needs to back-stop the destructive-class deny for
# the tiny set of tool ids that map to it in `BUILTIN_TOOL_RISKS`. Anything
# else exits 0 and the more specialised layers above take over.
#
# Inputs (PreToolUse JSON on stdin):
#   .tool_name        the tool id being invoked
# Exit codes:
#   0  allow (default for everything not matched below)
#   2  block; stderr is surfaced to Claude

set -euo pipefail

INPUT=$(cat)

TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)
if [ -z "$TOOL_NAME" ]; then
  # No tool name — let the SDK/CLI surface its own error rather than
  # silently blocking a malformed event.
  exit 0
fi

# Specialised hooks own these matchers. Don't double-handle.
case "$TOOL_NAME" in
  Bash|shell.exec)
    exit 0
    ;;
  mcp__*)
    exit 0
    ;;
esac

# Built-in destructive tool ids — same set as `BUILTIN_TOOL_RISKS` in
# `src/core/tools/risk.ts` with risk tag `destructive`. The TS policy engine
# denies these unconditionally under the default config; we mirror that here.
case "$TOOL_NAME" in
  fs.delete|fs.rm|destructive.rm)
    printf '%s\n' "BLOCKED by .claude/hooks/policy-runtime.sh: destructive tool denied by default policy" >&2
    exit 2
    ;;
esac

# Default-allow at the hook layer. The SDK-side interceptor and Claude Code's
# approval prompts cover write/network/shell approval requirements.
exit 0
