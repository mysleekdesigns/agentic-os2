/**
 * Phase 12 — Security hardening invariants.
 *
 * The PRD ships a "default deny for shell + destructive tools" posture. These
 * tests pin the invariant at two levels:
 *
 *   1. The Zod-parsed default `SecurityConfig` has `risk_levels.destructive ===
 *      'deny'` and `risk_levels.shell === 'approval_required'`.
 *   2. The policy engine, fed the default security config, denies destructive
 *      tools and gates shell tools behind approval regardless of whether the
 *      agent's allow-list lists them.
 */
import { describe, expect, it } from 'vitest';

import { SecurityConfigSchema } from '../../../src/config/schema.js';
import type { AgentFrontmatter } from '../../../src/core/agents/schema.js';
import { evaluate } from '../../../src/core/tools/policy.js';

function makeAgent(
  overrides: Partial<Pick<AgentFrontmatter, 'tools' | 'permissions'>> = {},
): Pick<AgentFrontmatter, 'id' | 'tools' | 'permissions'> {
  return {
    id: 'fixture',
    tools: {
      allowed: [],
      approval_required: [],
      ...overrides.tools,
    },
    permissions: {
      network: 'approval_required',
      file_read: 'allow',
      file_write: 'approval_required',
      shell: 'approval_required',
      ...overrides.permissions,
    },
  };
}

describe('default SecurityConfig — destructive + shell posture', () => {
  it('defaults risk_levels.destructive to deny', () => {
    const sec = SecurityConfigSchema.parse({});
    expect(sec.risk_levels.destructive).toBe('deny');
  });

  it('defaults risk_levels.shell to approval_required', () => {
    const sec = SecurityConfigSchema.parse({});
    expect(sec.risk_levels.shell).toBe('approval_required');
  });

  it('defaults secret_patterns to []', () => {
    const sec = SecurityConfigSchema.parse({});
    expect(sec.secret_patterns).toEqual([]);
  });
});

describe('policy.evaluate — default deny for destructive tools', () => {
  const security = SecurityConfigSchema.parse({});

  it('denies fs.rm even when listed in the agent allow-list', () => {
    const decision = evaluate({
      tool: 'fs.rm',
      agent: makeAgent({ tools: { allowed: ['fs.rm'], approval_required: [] } }),
      security,
    });
    expect(decision.outcome).toBe('deny');
    expect(decision.risk).toBe('destructive');
  });

  it('denies fs.delete even when listed in agent approval_required', () => {
    const decision = evaluate({
      tool: 'fs.delete',
      agent: makeAgent({ tools: { allowed: [], approval_required: ['fs.delete'] } }),
      security,
    });
    expect(decision.outcome).toBe('deny');
    expect(decision.risk).toBe('destructive');
  });

  it('denies destructive.rm even when listed in both lists', () => {
    const decision = evaluate({
      tool: 'destructive.rm',
      agent: makeAgent({
        tools: { allowed: ['destructive.rm'], approval_required: ['destructive.rm'] },
      }),
      security,
    });
    expect(decision.outcome).toBe('deny');
  });
});

describe('policy.evaluate — default approval_required for shell tools', () => {
  const security = SecurityConfigSchema.parse({});

  it('gates shell.exec behind approval even when listed in the allow-list', () => {
    const decision = evaluate({
      tool: 'shell.exec',
      agent: makeAgent({ tools: { allowed: ['shell.exec'], approval_required: [] } }),
      security,
    });
    expect(decision.outcome).toBe('approval_required');
    expect(decision.risk).toBe('shell');
  });

  it('gates Bash behind approval even when listed in the allow-list', () => {
    const decision = evaluate({
      tool: 'Bash',
      agent: makeAgent({ tools: { allowed: ['Bash'], approval_required: [] } }),
      security,
    });
    expect(decision.outcome).toBe('approval_required');
    expect(decision.risk).toBe('shell');
  });

  it('gates shell.exec behind approval even when the agent has no allow-list at all', () => {
    const decision = evaluate({
      tool: 'shell.exec',
      agent: makeAgent(),
      security,
    });
    expect(decision.outcome).toBe('approval_required');
  });
});
