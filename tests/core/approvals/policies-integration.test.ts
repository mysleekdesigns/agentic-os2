/**
 * Policy integration tests (PRD §3 Phase 6).
 *
 * Complements `tests/core/approvals/policies.test.ts`, which unit-tests each
 * helper in isolation. Here we drive `evaluateWithApprovalPolicies` end-to-end
 * through the real config schema with a realistic agent + security shape,
 * and assert each of the three scopes (per_tool / per_agent / per_workflow)
 * upgrades a base `allow` decision to `approval_required`.
 *
 * Precedence ladder (from `src/core/approvals/policies.ts`):
 *   1. base `deny` always wins
 *   2. any scope demanding approval → upgrade `allow` → `approval_required`
 *   3. otherwise the base verdict is preserved
 */

import { describe, expect, it } from 'vitest';

import { AgentOsConfigSchema, type SecurityConfig } from '../../../src/config/schema.js';
import {
  evaluateWithApprovalPolicies,
  loadApprovalPolicies,
} from '../../../src/core/approvals/index.js';
import type { AgentFrontmatter } from '../../../src/core/agents/schema.js';

/**
 * A "permissive" agent + security pair that makes `fs.write` a plain `allow`
 * under the base evaluator. Each test then layers a single policy scope on
 * top and asserts the verdict is upgraded.
 */
const permissiveAgent: Pick<AgentFrontmatter, 'id' | 'tools' | 'permissions'> = {
  id: 'research_agent',
  tools: { allowed: ['fs.write', 'fs.read'], approval_required: [] },
  permissions: {
    network: 'allow',
    file_read: 'allow',
    file_write: 'allow',
    shell: 'deny',
  },
};

const permissiveSecurity: SecurityConfig = {
  default_tool_policy: 'allow',
  risk_levels: {
    read: 'allow',
    write: 'allow',
    network: 'allow',
    shell: 'approval_required',
    destructive: 'deny',
  },
  pinned_mcp_servers: true,
  redact_secrets_in_logs: true,
};

describe('evaluateWithApprovalPolicies — scope upgrades (integration)', () => {
  it('per_tool: require_approval=true upgrades base allow → approval_required', () => {
    const config = AgentOsConfigSchema.parse({
      approvals: {
        channels: ['cli'],
        default_ttl_minutes: 10,
        policies: {
          per_tool: { 'fs.write': { require_approval: true } },
        },
      },
    });
    const policies = loadApprovalPolicies(config);

    // Sanity: without policies, the base verdict on `fs.write` for this
    // agent+security is `allow`.
    const baseline = evaluateWithApprovalPolicies({
      tool: 'fs.write',
      agent: permissiveAgent,
      security: permissiveSecurity,
    });
    expect(baseline.outcome).toBe('allow');

    const decision = evaluateWithApprovalPolicies({
      tool: 'fs.write',
      agent: permissiveAgent,
      security: permissiveSecurity,
      policies,
    });
    expect(decision.outcome).toBe('approval_required');
    expect(decision.reason).toMatch(/approvals\.policies/);
  });

  it('per_agent: require_approval_for_tools entry upgrades base allow → approval_required', () => {
    const config = AgentOsConfigSchema.parse({
      approvals: {
        channels: ['cli'],
        default_ttl_minutes: 10,
        policies: {
          per_agent: {
            research_agent: { require_approval_for_tools: ['fs.write'] },
          },
        },
      },
    });
    const policies = loadApprovalPolicies(config);

    const decision = evaluateWithApprovalPolicies({
      tool: 'fs.write',
      agent: permissiveAgent,
      security: permissiveSecurity,
      policies,
    });
    expect(decision.outcome).toBe('approval_required');

    // A different agent does NOT trip the upgrade.
    const otherDecision = evaluateWithApprovalPolicies({
      tool: 'fs.write',
      agent: { ...permissiveAgent, id: 'other_agent' },
      security: permissiveSecurity,
      policies,
    });
    expect(otherDecision.outcome).toBe('allow');
  });

  it('per_workflow: require_approval_for_steps entry upgrades base allow → approval_required when the step name matches', () => {
    const config = AgentOsConfigSchema.parse({
      approvals: {
        channels: ['cli'],
        default_ttl_minutes: 10,
        policies: {
          per_workflow: {
            'bugfix-loop': { require_approval_for_steps: ['patch'] },
          },
        },
      },
    });
    const policies = loadApprovalPolicies(config);

    const decision = evaluateWithApprovalPolicies({
      tool: 'fs.write',
      agent: permissiveAgent,
      security: permissiveSecurity,
      policies,
      workflowId: 'bugfix-loop',
      stepName: 'patch',
    });
    expect(decision.outcome).toBe('approval_required');

    // Same workflow, a different step name → no upgrade.
    const otherStep = evaluateWithApprovalPolicies({
      tool: 'fs.write',
      agent: permissiveAgent,
      security: permissiveSecurity,
      policies,
      workflowId: 'bugfix-loop',
      stepName: 'something-else',
    });
    expect(otherStep.outcome).toBe('allow');
  });

  it('preserves base deny verdicts even when a scope would otherwise upgrade', () => {
    // `destructive` risk class is denied by the security config; even though
    // a per_tool policy demands approval, deny wins (precedence rule #1).
    const denySecurity: SecurityConfig = {
      ...permissiveSecurity,
      risk_levels: { ...permissiveSecurity.risk_levels, write: 'deny' },
    };
    const config = AgentOsConfigSchema.parse({
      approvals: {
        channels: ['cli'],
        default_ttl_minutes: 10,
        policies: { per_tool: { 'fs.write': { require_approval: true } } },
      },
    });
    const policies = loadApprovalPolicies(config);

    const decision = evaluateWithApprovalPolicies({
      tool: 'fs.write',
      agent: permissiveAgent,
      security: denySecurity,
      policies,
    });
    expect(decision.outcome).toBe('deny');
  });

  it('absent policies argument preserves the base verdict (no-op)', () => {
    const decision = evaluateWithApprovalPolicies({
      tool: 'fs.write',
      agent: permissiveAgent,
      security: permissiveSecurity,
    });
    expect(decision.outcome).toBe('allow');
  });
});
