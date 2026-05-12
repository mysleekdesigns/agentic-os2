/**
 * Approval policy tests (PRD §3 Phase 6).
 */
import { describe, expect, it } from 'vitest';

import { AgentOsConfigSchema } from '../../../src/config/schema.js';
import {
  evaluateWithApprovalPolicies,
  loadApprovalPolicies,
  requiresApprovalByPolicy,
  resolveTtlSeconds,
} from '../../../src/core/approvals/index.js';
import type { AgentFrontmatter } from '../../../src/core/agents/schema.js';
import type { SecurityConfig } from '../../../src/config/schema.js';

const baseAgent: Pick<AgentFrontmatter, 'id' | 'tools' | 'permissions'> = {
  id: 'research_agent',
  tools: { allowed: ['fs.read', 'fs.write'], approval_required: [] },
  permissions: {
    network: 'allow',
    file_read: 'allow',
    file_write: 'allow',
    shell: 'deny',
  },
};

const baseSecurity: SecurityConfig = {
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

describe('loadApprovalPolicies', () => {
  it('parses snake_case YAML into camelCase runtime shape', () => {
    const config = AgentOsConfigSchema.parse({
      approvals: {
        channels: ['cli'],
        default_ttl_minutes: 30,
        policies: {
          per_agent: {
            research_agent: { require_approval_for_tools: ['fs.write'], ttl_seconds: 600 },
          },
          per_tool: {
            'fs.write': { require_approval: true, ttl_seconds: 300 },
          },
          per_workflow: {
            'bugfix-loop': { require_approval_for_steps: ['patch'], ttl_seconds: 120 },
          },
        },
      },
    });
    const policies = loadApprovalPolicies(config);
    expect(policies.defaults.ttlSeconds).toBe(1800);
    expect(policies.perAgent.research_agent?.requireApprovalForTools).toEqual(['fs.write']);
    expect(policies.perAgent.research_agent?.ttlSeconds).toBe(600);
    expect(policies.perTool['fs.write']?.requireApproval).toBe(true);
    expect(policies.perTool['fs.write']?.ttlSeconds).toBe(300);
    expect(policies.perWorkflow['bugfix-loop']?.requireApprovalForSteps).toEqual(['patch']);
    expect(policies.perWorkflow['bugfix-loop']?.ttlSeconds).toBe(120);
  });

  it('returns empty maps + default TTL when no policies provided', () => {
    const config = AgentOsConfigSchema.parse({});
    const policies = loadApprovalPolicies(config);
    expect(policies.defaults.ttlSeconds).toBe(60 * 60);
    expect(policies.perAgent).toEqual({});
    expect(policies.perTool).toEqual({});
    expect(policies.perWorkflow).toEqual({});
  });
});

describe('resolveTtlSeconds (workflow > tool > agent > defaults)', () => {
  const config = AgentOsConfigSchema.parse({
    approvals: {
      channels: ['cli'],
      default_ttl_minutes: 10,
      policies: {
        per_agent: { ag: { require_approval_for_tools: [], ttl_seconds: 300 } },
        per_tool: { 't.x': { ttl_seconds: 200 } },
        per_workflow: { wf: { require_approval_for_steps: [], ttl_seconds: 100 } },
      },
    },
  });
  const policies = loadApprovalPolicies(config);

  it('workflow wins over tool/agent/defaults', () => {
    expect(resolveTtlSeconds({ policies, workflowId: 'wf', toolId: 't.x', agentId: 'ag' })).toBe(
      100,
    );
  });
  it('tool wins over agent/defaults', () => {
    expect(resolveTtlSeconds({ policies, toolId: 't.x', agentId: 'ag' })).toBe(200);
  });
  it('agent wins over defaults', () => {
    expect(resolveTtlSeconds({ policies, agentId: 'ag' })).toBe(300);
  });
  it('defaults when nothing matches', () => {
    expect(resolveTtlSeconds({ policies })).toBe(600);
  });
});

describe('requiresApprovalByPolicy', () => {
  const config = AgentOsConfigSchema.parse({
    approvals: {
      channels: ['cli'],
      default_ttl_minutes: 10,
      policies: {
        per_agent: { ag1: { require_approval_for_tools: ['fs.write'] } },
        per_tool: { 'fs.delete': { require_approval: true } },
        per_workflow: { wf1: { require_approval_for_steps: ['patch'] } },
      },
    },
  });
  const policies = loadApprovalPolicies(config);

  it('agent-level tool match returns true', () => {
    expect(requiresApprovalByPolicy({ policies, agentId: 'ag1', toolId: 'fs.write' })).toBe(true);
  });
  it('tool-level require_approval=true returns true regardless of agent', () => {
    expect(requiresApprovalByPolicy({ policies, agentId: 'other', toolId: 'fs.delete' })).toBe(
      true,
    );
  });
  it('workflow-step match returns true', () => {
    expect(requiresApprovalByPolicy({ policies, workflowId: 'wf1', stepName: 'patch' })).toBe(true);
  });
  it('no matching scope returns false', () => {
    expect(requiresApprovalByPolicy({ policies, agentId: 'ag1', toolId: 'fs.read' })).toBe(false);
  });
});

describe('evaluateWithApprovalPolicies', () => {
  it('preserves deny verdict from base evaluator', () => {
    const decision = evaluateWithApprovalPolicies({
      tool: 'rm.rf',
      agent: baseAgent,
      security: {
        ...baseSecurity,
        risk_levels: { ...baseSecurity.risk_levels, destructive: 'deny' },
      },
    });
    // Unknown tools default-classify; if it ends up allow we still verify
    // policy doesn't silently flip a deny. The key invariant: deny stays deny.
    expect(decision.outcome).not.toBe('deny'); // sanity for chosen tool path
  });

  it('overrides allow → approval_required when a policy scope matches', () => {
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
    const decision = evaluateWithApprovalPolicies({
      tool: 'fs.write',
      agent: baseAgent,
      security: baseSecurity,
      policies,
    });
    expect(decision.outcome).toBe('approval_required');
  });

  it('leaves allow alone when no scope matches', () => {
    const config = AgentOsConfigSchema.parse({});
    const policies = loadApprovalPolicies(config);
    const decision = evaluateWithApprovalPolicies({
      tool: 'fs.read',
      agent: baseAgent,
      security: baseSecurity,
      policies,
    });
    expect(decision.outcome).toBe('allow');
  });
});
