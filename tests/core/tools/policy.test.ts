import { describe, expect, it } from 'vitest';
import { SecurityConfigSchema, type SecurityConfig } from '../../../src/config/schema.js';
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

function defaultSecurity(over: Partial<SecurityConfig> = {}): SecurityConfig {
  return SecurityConfigSchema.parse({ ...over });
}

describe('evaluate — risk_levels deny wins', () => {
  it('denies destructive tools even when listed in allow-list', () => {
    const decision = evaluate({
      tool: 'fs.rm',
      agent: makeAgent({ tools: { allowed: ['fs.rm'], approval_required: [] } }),
      security: defaultSecurity(),
    });
    expect(decision.outcome).toBe('deny');
    expect(decision.risk).toBe('destructive');
    expect(decision.rule).toBe('risk_levels');
    expect(decision.reason).toMatch(/destructive/);
  });

  it('denies destructive tools even when listed in approval_required', () => {
    const decision = evaluate({
      tool: 'fs.delete',
      agent: makeAgent({ tools: { allowed: [], approval_required: ['fs.delete'] } }),
      security: defaultSecurity(),
    });
    expect(decision.outcome).toBe('deny');
    expect(decision.rule).toBe('risk_levels');
  });
});

describe('evaluate — agent approval list wins over allow-list', () => {
  it('returns approval_required when the tool appears in both lists', () => {
    const decision = evaluate({
      tool: 'Read',
      agent: makeAgent({
        tools: { allowed: ['Read'], approval_required: ['Read'] },
      }),
      security: defaultSecurity(),
    });
    expect(decision.outcome).toBe('approval_required');
    expect(decision.rule).toBe('agent_approval');
    expect(decision.risk).toBe('read');
  });

  it('returns approval_required for a write tool listed in approval_required', () => {
    const decision = evaluate({
      tool: 'Edit',
      agent: makeAgent({ tools: { allowed: [], approval_required: ['Edit'] } }),
      security: defaultSecurity(),
    });
    expect(decision.outcome).toBe('approval_required');
    expect(decision.rule).toBe('agent_approval');
  });
});

describe('evaluate — risk_levels approval overrides allow-list', () => {
  it('write tool in allow-list with risk_levels.write=approval_required -> approval_required', () => {
    const decision = evaluate({
      tool: 'Write',
      agent: makeAgent({ tools: { allowed: ['Write'], approval_required: [] } }),
      security: defaultSecurity(),
    });
    expect(decision.outcome).toBe('approval_required');
    expect(decision.rule).toBe('risk_levels');
    expect(decision.risk).toBe('write');
  });

  it('network tool in allow-list with default risk_levels.network=approval_required', () => {
    const decision = evaluate({
      tool: 'WebFetch',
      agent: makeAgent({ tools: { allowed: ['WebFetch'], approval_required: [] } }),
      security: defaultSecurity(),
    });
    expect(decision.outcome).toBe('approval_required');
    expect(decision.rule).toBe('risk_levels');
  });
});

describe('evaluate — agent allow-list grants', () => {
  it('read tool in allow-list with risk_levels.read=allow -> allow', () => {
    const decision = evaluate({
      tool: 'Read',
      agent: makeAgent({ tools: { allowed: ['Read'], approval_required: [] } }),
      security: defaultSecurity(),
    });
    expect(decision.outcome).toBe('allow');
    expect(decision.rule).toBe('agent_allow');
    expect(decision.risk).toBe('read');
  });

  it('multiple read tools in allow-list resolve independently', () => {
    const agent = makeAgent({
      tools: { allowed: ['Read', 'Glob', 'Grep'], approval_required: [] },
    });
    for (const tool of ['Read', 'Glob', 'Grep']) {
      const decision = evaluate({ tool, agent, security: defaultSecurity() });
      expect(decision.outcome).toBe('allow');
      expect(decision.rule).toBe('agent_allow');
    }
  });
});

describe('evaluate — default_tool_policy fallback', () => {
  it('unknown tool not in any list with default_tool_policy=deny -> deny (unknown_tool)', () => {
    const decision = evaluate({
      tool: 'some_random_thing',
      agent: makeAgent(),
      security: defaultSecurity({ default_tool_policy: 'deny' }),
    });
    expect(decision.outcome).toBe('deny');
    expect(decision.rule).toBe('unknown_tool');
    expect(decision.reason).toMatch(/not in agent allow-list/);
  });

  it('unknown tool with default_tool_policy=allow AND read risk -> allow', () => {
    // classifyTool returns `read` for unknown ids by default; risk_levels.read defaults to `allow`.
    const decision = evaluate({
      tool: 'some_random_thing',
      agent: makeAgent(),
      security: defaultSecurity({ default_tool_policy: 'allow' }),
    });
    expect(decision.outcome).toBe('allow');
    expect(decision.rule).toBe('default_tool_policy');
    expect(decision.risk).toBe('read');
  });

  it('read tool not in agent allow-list with default_tool_policy=deny -> deny', () => {
    const decision = evaluate({
      tool: 'Read',
      agent: makeAgent(),
      security: defaultSecurity({ default_tool_policy: 'deny' }),
    });
    expect(decision.outcome).toBe('deny');
    // Read is a known built-in, so this is a known tool not in the agent's lists.
    expect(decision.rule).toBe('unknown_tool');
  });
});

describe('evaluate — decision shape', () => {
  it('always reports the resolved risk tag', () => {
    const d = evaluate({
      tool: 'Bash',
      agent: makeAgent({ tools: { allowed: ['Bash'], approval_required: [] } }),
      security: defaultSecurity(),
    });
    expect(d.risk).toBe('shell');
    expect(d.outcome).toBe('approval_required');
  });

  it('reason is a non-empty string for every branch', () => {
    const cases = [
      { tool: 'fs.rm', agent: makeAgent(), security: defaultSecurity() },
      {
        tool: 'Edit',
        agent: makeAgent({ tools: { allowed: [], approval_required: ['Edit'] } }),
        security: defaultSecurity(),
      },
      {
        tool: 'Write',
        agent: makeAgent({ tools: { allowed: ['Write'], approval_required: [] } }),
        security: defaultSecurity(),
      },
      {
        tool: 'Read',
        agent: makeAgent({ tools: { allowed: ['Read'], approval_required: [] } }),
        security: defaultSecurity(),
      },
      {
        tool: 'whatever',
        agent: makeAgent(),
        security: defaultSecurity({ default_tool_policy: 'allow' }),
      },
      {
        tool: 'whatever',
        agent: makeAgent(),
        security: defaultSecurity({ default_tool_policy: 'deny' }),
      },
    ];
    for (const c of cases) {
      const d = evaluate(c);
      expect(typeof d.reason).toBe('string');
      expect(d.reason.length).toBeGreaterThan(0);
    }
  });

  it('rule discriminator covers all five branches across fixtures', () => {
    const seen = new Set<string>();
    seen.add(evaluate({ tool: 'fs.rm', agent: makeAgent(), security: defaultSecurity() }).rule);
    seen.add(
      evaluate({
        tool: 'Edit',
        agent: makeAgent({ tools: { allowed: [], approval_required: ['Edit'] } }),
        security: defaultSecurity(),
      }).rule,
    );
    seen.add(
      evaluate({
        tool: 'Read',
        agent: makeAgent({ tools: { allowed: ['Read'], approval_required: [] } }),
        security: defaultSecurity(),
      }).rule,
    );
    seen.add(
      evaluate({
        tool: 'whatever',
        agent: makeAgent(),
        security: defaultSecurity({ default_tool_policy: 'allow' }),
      }).rule,
    );
    seen.add(
      evaluate({
        tool: 'whatever',
        agent: makeAgent(),
        security: defaultSecurity({ default_tool_policy: 'deny' }),
      }).rule,
    );
    expect(seen).toEqual(
      new Set([
        'risk_levels',
        'agent_approval',
        'agent_allow',
        'default_tool_policy',
        'unknown_tool',
      ]),
    );
  });
});
