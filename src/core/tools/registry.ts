/**
 * Tool registry.
 *
 * In-process catalog of tools known to the runtime. Seeded with the static
 * built-ins from `BUILTIN_TOOL_RISKS`; agents and providers may register
 * additional tools at startup (e.g. MCP servers discovered during init).
 *
 * The registry is the policy engine's first lookup; the classifier is the
 * fallback when a tool was never registered. PRD §1.7, §2.5.
 */

import { BUILTIN_TOOL_RISKS, classifyTool, type RiskTag } from './risk.js';

export interface ToolDescriptor {
  id: string;
  risk: RiskTag;
  /** Free-form description for logs/audit only. */
  description?: string;
}

/** Mutable registry seeded with built-ins; agents may register additional tools at startup. */
export interface ToolRegistry {
  register(desc: ToolDescriptor): void;
  get(id: string): ToolDescriptor | undefined;
  has(id: string): boolean;
  list(): readonly ToolDescriptor[];
  /** Resolve risk for a tool id, consulting the registry first then `classifyTool`. */
  riskFor(id: string): RiskTag;
}

/**
 * Create a fresh registry pre-populated with the built-in tools.
 *
 * `register` is last-write-wins: re-registering an existing id overwrites the
 * previous descriptor. Callers that need uniqueness should `has()` first.
 */
export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, ToolDescriptor>();

  for (const [id, risk] of Object.entries(BUILTIN_TOOL_RISKS)) {
    tools.set(id, { id, risk });
  }

  return {
    register(desc: ToolDescriptor): void {
      tools.set(desc.id, { ...desc });
    },
    get(id: string): ToolDescriptor | undefined {
      const entry = tools.get(id);
      return entry ? { ...entry } : undefined;
    },
    has(id: string): boolean {
      return tools.has(id);
    },
    list(): readonly ToolDescriptor[] {
      return Array.from(tools.values()).map((t) => ({ ...t }));
    },
    riskFor(id: string): RiskTag {
      const entry = tools.get(id);
      return entry ? entry.risk : classifyTool(id);
    },
  };
}
