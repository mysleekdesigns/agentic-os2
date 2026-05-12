/**
 * Tool risk classifier.
 *
 * Maps a tool id (built-in name, dotted helper, or MCP namespaced id) to a
 * coarse risk tag consumed by the policy engine. PRD §1.7 — risk-tagged tools.
 *
 * Pure module: no I/O, no globals beyond the static built-in map. Callers
 * (registry, policy engine) treat the classifier as the fallback when a tool
 * isn't registered.
 */

export type RiskTag = 'read' | 'write' | 'network' | 'shell' | 'destructive';

/**
 * Static classification for built-in tool ids. Treated as the source of truth
 * when present; tools missing here fall through to `classifyTool()`'s
 * heuristics. PRD §1.7 — risk-tagged tools.
 */
export const BUILTIN_TOOL_RISKS: Readonly<Record<string, RiskTag>> = Object.freeze({
  // read
  'fs.read': 'read',
  Read: 'read',
  Glob: 'read',
  Grep: 'read',
  LS: 'read',

  // write
  'fs.write': 'write',
  Edit: 'write',
  Write: 'write',
  NotebookEdit: 'write',

  // network
  WebFetch: 'network',
  WebSearch: 'network',
  'network.fetch': 'network',

  // shell
  Bash: 'shell',
  'shell.exec': 'shell',

  // destructive
  'fs.delete': 'destructive',
  'fs.rm': 'destructive',
  'destructive.rm': 'destructive',
});

/**
 * MCP id forms: `mcp__server__tool` and `mcp.server.tool`. The server group is
 * non-greedy so server names containing underscores (e.g. `claude_ai_Gmail`)
 * still match — `__` is the literal separator and the tool segment greedily
 * consumes the rest. Without the lazy quantifier we would mis-classify any
 * underscored server's tools and silently fall through to `unknownDefault`.
 */
const MCP_DUNDER_RE = /^mcp__(.+?)__(.+)$/;
const MCP_DOT_RE = /^mcp\.([^.]+)\.(.+)$/;

/** Verb suffixes on MCP tool names that imply a write/mutation rather than a pure fetch. */
const WRITE_VERB_RE = /write|edit|create|update|delete|rm|put|post|exec|send/i;

/**
 * Resolve a tool id to its risk tag.
 *
 * Order:
 *   1. exact match in `BUILTIN_TOOL_RISKS` merged with the caller-supplied
 *      `overrides` map (overrides win on collision)
 *   2. namespaced MCP heuristic — `mcp__<server>__<tool>` or `mcp.<server>.<tool>`
 *      default to `network`, upgraded to `write` if the tool suffix matches a
 *      write-verb regex (write|edit|create|update|delete|rm|put|post|exec|send)
 *   3. fallback for unknown tools = `opts.unknownDefault` (defaults to `read`
 *      when omitted; callers should pass the explicit project default)
 *
 * Pure. No side effects.
 */
export function classifyTool(
  tool: string,
  opts?: { overrides?: Readonly<Record<string, RiskTag>>; unknownDefault?: RiskTag },
): RiskTag {
  const overrides = opts?.overrides;
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, tool)) {
    return overrides[tool] as RiskTag;
  }
  if (Object.prototype.hasOwnProperty.call(BUILTIN_TOOL_RISKS, tool)) {
    return BUILTIN_TOOL_RISKS[tool] as RiskTag;
  }

  const mcpMatch = MCP_DUNDER_RE.exec(tool) ?? MCP_DOT_RE.exec(tool);
  if (mcpMatch) {
    const suffix = mcpMatch[2] ?? '';
    return WRITE_VERB_RE.test(suffix) ? 'write' : 'network';
  }

  return opts?.unknownDefault ?? 'read';
}
