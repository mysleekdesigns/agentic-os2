/**
 * Approval policies — per-agent / per-tool / per-workflow overrides
 * (PRD §3 Phase 6: "configurable policies").
 *
 * This module sits ABOVE `src/core/tools/policy.ts`. The existing policy
 * function combines agent allow/approval lists with `security.risk_levels` to
 * produce `'allow' | 'approval_required' | 'deny'`. Here we add an additional
 * gate: an `ApprovalPolicies` map sourced from `config.approvals.policies`
 * that can FORCE `approval_required` based on tool / agent / workflow scope.
 *
 * Precedence ladder (highest first):
 *   1. The existing `evaluate(...)` deny outcome — `deny` always wins.
 *   2. Any of (workflow scope, tool scope, agent scope) demanding approval.
 *      Tool-level explicit `false` does NOT override an explicit `true` from
 *      another scope — "require approval" is a one-way ratchet.
 *   3. The existing `evaluate(...)` verdict otherwise.
 *
 * TTL precedence (most-specific wins): workflow > tool > agent > defaults.
 *
 * Config shape (YAML, snake_case):
 *
 *   approvals:
 *     channels: [cli]
 *     default_ttl_minutes: 60
 *     policies:
 *       per_agent:
 *         research_agent:
 *           require_approval_for_tools: [fs.write]
 *           ttl_seconds: 3600
 *       per_tool:
 *         fs.write: { require_approval: true, ttl_seconds: 1800 }
 *       per_workflow:
 *         bugfix-loop:
 *           require_approval_for_steps: [patch]
 *           ttl_seconds: 600
 *
 * The runtime `ApprovalPolicies` shape uses camelCase TS keys; conversion
 * happens at the loader boundary (`loadApprovalPolicies`).
 */

import type { AgentOsConfig } from '../../config/schema.js';
import { evaluate, type EvaluateInput, type PolicyDecision } from '../tools/policy.js';

export interface AgentPolicy {
  requireApprovalForTools?: string[];
  ttlSeconds?: number;
}

export interface ToolPolicy {
  requireApproval?: boolean;
  ttlSeconds?: number;
}

export interface WorkflowPolicy {
  requireApprovalForSteps?: string[];
  ttlSeconds?: number;
}

export interface ApprovalPolicies {
  perAgent: Record<string, AgentPolicy>;
  perTool: Record<string, ToolPolicy>;
  perWorkflow: Record<string, WorkflowPolicy>;
  defaults: { ttlSeconds: number };
}

const EMPTY_POLICIES: ApprovalPolicies = {
  perAgent: {},
  perTool: {},
  perWorkflow: {},
  defaults: { ttlSeconds: 60 * 60 },
};

/**
 * Read `config.approvals` into a runtime `ApprovalPolicies` object. Converts
 * snake_case YAML keys to camelCase TS keys; preserves explicit `undefined`
 * for optional TTLs so resolution can fall through to a less-specific scope.
 */
export function loadApprovalPolicies(config: AgentOsConfig): ApprovalPolicies {
  const approvals = config.approvals;
  const defaultTtlSeconds = approvals.default_ttl_minutes * 60;
  const result: ApprovalPolicies = {
    perAgent: {},
    perTool: {},
    perWorkflow: {},
    defaults: { ttlSeconds: defaultTtlSeconds },
  };

  const policies = approvals.policies;
  if (!policies) return result;

  for (const [agentId, ap] of Object.entries(policies.per_agent ?? {})) {
    const entry: AgentPolicy = {
      requireApprovalForTools: ap.require_approval_for_tools ?? [],
    };
    if (ap.ttl_seconds !== undefined) entry.ttlSeconds = ap.ttl_seconds;
    result.perAgent[agentId] = entry;
  }
  for (const [toolId, tp] of Object.entries(policies.per_tool ?? {})) {
    const entry: ToolPolicy = {};
    if (tp.require_approval !== undefined) entry.requireApproval = tp.require_approval;
    if (tp.ttl_seconds !== undefined) entry.ttlSeconds = tp.ttl_seconds;
    result.perTool[toolId] = entry;
  }
  for (const [workflowId, wp] of Object.entries(policies.per_workflow ?? {})) {
    const entry: WorkflowPolicy = {
      requireApprovalForSteps: wp.require_approval_for_steps ?? [],
    };
    if (wp.ttl_seconds !== undefined) entry.ttlSeconds = wp.ttl_seconds;
    result.perWorkflow[workflowId] = entry;
  }
  return result;
}

export interface ResolveTtlInput {
  policies: ApprovalPolicies;
  agentId?: string;
  toolId?: string;
  workflowId?: string;
}

/**
 * Pick the most-specific configured TTL: workflow > tool > agent > defaults.
 * Always returns a finite number (>= 1 second).
 */
export function resolveTtlSeconds(input: ResolveTtlInput): number {
  const { policies, agentId, toolId, workflowId } = input;
  if (workflowId) {
    const wf = policies.perWorkflow[workflowId];
    if (wf?.ttlSeconds !== undefined) return wf.ttlSeconds;
  }
  if (toolId) {
    const tp = policies.perTool[toolId];
    if (tp?.ttlSeconds !== undefined) return tp.ttlSeconds;
  }
  if (agentId) {
    const ap = policies.perAgent[agentId];
    if (ap?.ttlSeconds !== undefined) return ap.ttlSeconds;
  }
  return policies.defaults.ttlSeconds;
}

export interface RequiresApprovalByPolicyInput {
  policies: ApprovalPolicies;
  agentId?: string;
  toolId?: string;
  stepName?: string;
  workflowId?: string;
}

/**
 * Returns true when any configured scope demands approval. A tool-level
 * explicit `false` does NOT override an agent- or workflow-level `true` —
 * "require approval" is a one-way ratchet (safety wins).
 */
export function requiresApprovalByPolicy(input: RequiresApprovalByPolicyInput): boolean {
  const { policies, agentId, toolId, stepName, workflowId } = input;

  if (workflowId && stepName) {
    const wf = policies.perWorkflow[workflowId];
    if (wf?.requireApprovalForSteps?.includes(stepName)) return true;
  }
  if (toolId) {
    const tp = policies.perTool[toolId];
    if (tp?.requireApproval === true) return true;
  }
  if (agentId && toolId) {
    const ap = policies.perAgent[agentId];
    if (ap?.requireApprovalForTools?.includes(toolId)) return true;
  }
  return false;
}

export interface EvaluateWithApprovalPoliciesInput extends EvaluateInput {
  policies?: ApprovalPolicies;
  workflowId?: string;
  stepName?: string;
}

/**
 * Wrapper around `evaluate(...)` from `src/core/tools/policy.ts` that ALSO
 * consults the approval policies map.
 *
 * Behaviour:
 * - If the base decision is `deny`, return it unchanged (deny always wins).
 * - If any policy scope demands approval, override `allow` → `approval_required`
 *   with rule='approval_policies'.
 * - Otherwise, return the base decision unchanged.
 *
 * The original `evaluate(...)` function is left untouched so Phase 4 callers
 * keep working without modification.
 */
export function evaluateWithApprovalPolicies(
  input: EvaluateWithApprovalPoliciesInput,
): PolicyDecision {
  const base = evaluate(input);
  if (!input.policies) return base;
  if (base.outcome === 'deny') return base;

  const needs = requiresApprovalByPolicy({
    policies: input.policies,
    agentId: input.agent.id,
    toolId: input.tool,
    ...(input.stepName !== undefined ? { stepName: input.stepName } : {}),
    ...(input.workflowId !== undefined ? { workflowId: input.workflowId } : {}),
  });

  if (needs && base.outcome === 'allow') {
    return {
      outcome: 'approval_required',
      risk: base.risk,
      reason: 'overridden by approvals.policies (per-agent/tool/workflow)',
      // Reuse the existing rule enum value most consistent with the override.
      // The original enum is fixed; we map this to 'agent_approval' as the
      // closest semantic match without changing the public union.
      rule: 'agent_approval',
    };
  }
  return base;
}

// Internal: expose the empty default for tests / consumers that want a
// zero-config policy map.
export function emptyApprovalPolicies(): ApprovalPolicies {
  return JSON.parse(JSON.stringify(EMPTY_POLICIES)) as ApprovalPolicies;
}
