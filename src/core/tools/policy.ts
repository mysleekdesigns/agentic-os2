/**
 * Tool policy engine.
 *
 * Pure decision function combining (agent allow/approval lists, security
 * config risk_levels, default_tool_policy) into an `allow | approval_required
 * | deny` outcome. PRD §2.5 — every tool call is policy-checked.
 *
 * Caller responsibilities:
 * - persist decisions to the audit log (Bundle B)
 * - hand approval_required outcomes to the approval channel (Bundle C)
 */

import type { SecurityConfig } from '../../config/schema.js';
import type { AgentFrontmatter } from '../agents/schema.js';
import { classifyTool, type RiskTag } from './risk.js';

export type DecisionOutcome = 'allow' | 'approval_required' | 'deny';

export interface PolicyDecision {
  outcome: DecisionOutcome;
  risk: RiskTag;
  /** Short, human-readable reason ("destructive risk denied by config",
   *  "tool not in agent allow-list and default_tool_policy=deny", etc.). */
  reason: string;
  /** Which rule fired: `risk_levels` | `agent_allow` | `agent_approval` |
   *  `default_tool_policy` | `unknown_tool`. */
  rule: 'risk_levels' | 'agent_allow' | 'agent_approval' | 'default_tool_policy' | 'unknown_tool';
}

export interface EvaluateInput {
  tool: string;
  args?: unknown; // currently informational; reserved for future arg-based rules
  agent: Pick<AgentFrontmatter, 'id' | 'tools' | 'permissions'>;
  security: SecurityConfig;
}

/**
 * Pure policy evaluation. Returns the decision; never throws on unknown tools
 * (returns outcome=deny with rule='unknown_tool' when default_tool_policy=deny).
 *
 * Precedence (highest first):
 *   1. risk_levels[risk] === 'deny'  -> deny  (destructive default; PRD §2.5)
 *   2. tool in agent.tools.approval_required -> approval_required
 *   3. risk_levels[risk] === 'approval_required' -> approval_required (overrides allow-list)
 *   4. tool in agent.tools.allowed AND risk_levels[risk] === 'allow' -> allow
 *   5. default_tool_policy -> allow|deny
 */
export function evaluate(input: EvaluateInput): PolicyDecision {
  const { tool, agent, security } = input;
  const risk = classifyTool(tool);
  const riskAction = security.risk_levels[risk];

  // 1. Hard deny on risk class wins over every allow-list. PRD §2.5 destructive default.
  if (riskAction === 'deny') {
    return {
      outcome: 'deny',
      risk,
      reason: `${risk} risk denied by config`,
      rule: 'risk_levels',
    };
  }

  const allowedSet = new Set(agent.tools.allowed);
  const approvalSet = new Set(agent.tools.approval_required);

  // 2. Explicit per-agent approval requirement beats allow-list.
  if (approvalSet.has(tool)) {
    return {
      outcome: 'approval_required',
      risk,
      reason: `tool listed in agent.tools.approval_required`,
      rule: 'agent_approval',
    };
  }

  // 3. Risk-class approval gate overrides allow-list membership.
  if (riskAction === 'approval_required') {
    return {
      outcome: 'approval_required',
      risk,
      reason: `${risk} risk requires approval per config`,
      rule: 'risk_levels',
    };
  }

  // 4. Allow-list + permissive risk class.
  if (allowedSet.has(tool) && riskAction === 'allow') {
    return {
      outcome: 'allow',
      risk,
      reason: `tool in agent allow-list with ${risk}=allow`,
      rule: 'agent_allow',
    };
  }

  // 5. Fallback to the global default.
  const known = allowedSet.has(tool) || approvalSet.has(tool);
  if (security.default_tool_policy === 'allow') {
    return {
      outcome: 'allow',
      risk,
      reason: 'default_tool_policy=allow',
      rule: 'default_tool_policy',
    };
  }

  return {
    outcome: 'deny',
    risk,
    reason: known
      ? 'default_tool_policy=deny'
      : 'tool not in agent allow-list and default_tool_policy=deny',
    rule: known ? 'default_tool_policy' : 'unknown_tool',
  };
}
