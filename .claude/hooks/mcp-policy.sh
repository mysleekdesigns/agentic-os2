#!/usr/bin/env bash
# PreToolUse hook for MCP-namespaced tool calls (Phase 4 / PRD §1.7).
#
# Receives the PreToolUse JSON on stdin; exit 2 blocks the call and sends
# stderr to Claude. The matcher in settings.json narrows this hook to tools
# whose name matches `mcp__.*` so we don't pay the jq startup cost for every
# tool — the in-script check is belt-and-suspenders.
#
# Blocks when:
#   - the tool's server name is not declared in `.mcp.json`
#   - `security.pinned_mcp_servers: true` is set in `agent-os.config.yaml`
#     but the matching `.mcp.json` entry lacks a `command_sha256`
#   - the entry has a `command_sha256` and the file on disk hashes differently
#
# Limitations:
#   - YAML parsing in bash is a pragmatic grep, not a full parser; if the
#     security block is exotic the hook errs on the side of allowing.
#   - When the resolved `command` is a bare token (e.g. `node`, `python`) we
#     skip the on-disk hash compare — pinning by bare token is checked
#     SDK-side by `loadMcpServers`. This hook only enforces file hashes.

set -euo pipefail

INPUT=$(cat)

TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)
if [ -z "$TOOL_NAME" ]; then
  exit 0
fi

# Only act on `mcp__*` tools. The settings.json matcher should already filter
# but we double-check so the hook is safe to run standalone (and to test).
case "$TOOL_NAME" in
  mcp__*) ;;
  *) exit 0 ;;
esac

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
MCP_JSON="${PROJECT_DIR}/.mcp.json"
CONFIG_YAML="${PROJECT_DIR}/agent-os.config.yaml"

# Missing .mcp.json → let the SDK surface its own error.
if [ ! -f "$MCP_JSON" ]; then
  exit 0
fi

# Parse server name out of `mcp__<server>__<tool>`. Server names may themselves
# contain underscores (e.g. `mcp__claude_ai_Gmail__authenticate`), so we strip
# the leading `mcp__` then strip the longest right-most `__*` suffix. Using
# regex-with-`[^_]+` here would mis-parse any underscored server name and
# silently exit 0 — a hook bypass.
STRIPPED="${TOOL_NAME#mcp__}"
SERVER_NAME="${STRIPPED%__*}"
if [ -z "$SERVER_NAME" ] || [ "$SERVER_NAME" = "$STRIPPED" ]; then
  # Malformed mcp tool name (no `__` separator after the prefix) — let SDK handle.
  exit 0
fi

block() {
  local reason="$1"
  printf '%s\n' "BLOCKED by .claude/hooks/mcp-policy.sh: $reason" >&2
  exit 2
}

# Pull the server entry from .mcp.json. If absent, hard-block.
ENTRY=$(jq -c --arg name "$SERVER_NAME" '.mcpServers[$name] // empty' "$MCP_JSON" 2>/dev/null || true)
if [ -z "$ENTRY" ] || [ "$ENTRY" = "null" ]; then
  block "MCP server '$SERVER_NAME' not declared in .mcp.json"
fi

CHECKSUM=$(printf '%s' "$ENTRY" | jq -r '.command_sha256 // empty' 2>/dev/null || true)
COMMAND=$(printf '%s' "$ENTRY" | jq -r '.command // empty' 2>/dev/null || true)

# Detect `security.pinned_mcp_servers: true` via a pragmatic grep. Robust YAML
# parsing in bash is out of scope here — the SDK-side loader uses Zod for the
# definitive check.
PINNED=false
if [ -f "$CONFIG_YAML" ] && grep -E 'pinned_mcp_servers:[[:space:]]*true' "$CONFIG_YAML" >/dev/null 2>&1; then
  PINNED=true
fi

if [ "$PINNED" = "true" ] && [ -z "$CHECKSUM" ]; then
  block "MCP server '$SERVER_NAME' has no command_sha256 (security.pinned_mcp_servers=true)"
fi

# If a checksum is declared and the command resolves to a real file, compare.
if [ -n "$CHECKSUM" ] && [ -n "$COMMAND" ] && [ -f "$COMMAND" ]; then
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL=$(sha256sum "$COMMAND" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    ACTUAL=$(shasum -a 256 "$COMMAND" | awk '{print $1}')
  else
    # No hasher available — fail closed under pinned mode, otherwise pass.
    if [ "$PINNED" = "true" ]; then
      block "no sha256 tool available to verify '$SERVER_NAME'"
    fi
    exit 0
  fi

  if [ "$ACTUAL" != "$CHECKSUM" ]; then
    block "MCP server '$SERVER_NAME' checksum mismatch (expected $CHECKSUM, got $ACTUAL)"
  fi
fi

exit 0
