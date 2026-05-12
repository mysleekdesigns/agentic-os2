import { describe, expect, it, vi } from 'vitest';

import type { AgentFrontmatter } from '../../../src/core/agents/schema.js';
import { FakeProvider, scriptedTranscript } from '../../../src/core/providers/index.js';
import type { AgentRunInput, RunEvent } from '../../../src/core/providers/index.js';
import {
  interceptProviderStream,
  stableHash,
  type ApprovalResolver,
  type ToolAuditor,
} from '../../../src/core/tools/interceptor.js';
import type { SecurityConfig } from '../../../src/config/schema.js';

type AgentForPolicy = Pick<AgentFrontmatter, 'id' | 'tools' | 'permissions'>;

function makeAgent(overrides: Partial<AgentForPolicy['tools']> = {}): AgentForPolicy {
  return {
    id: 'tester',
    tools: {
      allowed: overrides.allowed ?? ['fs.read'],
      approval_required: overrides.approval_required ?? ['fs.write'],
    },
    permissions: {
      network: 'approval_required',
      file_read: 'allow',
      file_write: 'approval_required',
      shell: 'deny',
    },
  };
}

function makeSecurity(overrides: Partial<SecurityConfig> = {}): SecurityConfig {
  return {
    default_tool_policy: 'deny',
    risk_levels: {
      read: 'allow',
      write: 'approval_required',
      network: 'approval_required',
      shell: 'approval_required',
      destructive: 'deny',
    },
    pinned_mcp_servers: true,
    redact_secrets_in_logs: true,
    ...overrides,
  };
}

function makeRunInput(): AgentRunInput {
  return {
    agentId: 'tester',
    goal: 'goal',
    instructions: '',
    workspaceRoot: '/tmp/x',
  };
}

async function collect(stream: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

interface AuditCalls {
  calls: Array<{
    toolCallId: string;
    tool: string;
    decision: string;
    rule: string;
    risk: string;
    decidedBy?: string;
  }>;
  results: Array<{ toolCallId: string; isError?: boolean; latencyMs: number }>;
}

function makeAuditor(): { auditor: ToolAuditor; calls: AuditCalls } {
  const sink: AuditCalls = { calls: [], results: [] };
  const auditor: ToolAuditor = {
    onCall(r) {
      sink.calls.push({
        toolCallId: r.toolCallId,
        tool: r.tool,
        decision: r.decision,
        rule: r.rule,
        risk: r.risk,
        ...(r.decidedBy !== undefined ? { decidedBy: r.decidedBy } : {}),
      });
    },
    onResult(r) {
      sink.results.push({
        toolCallId: r.toolCallId,
        ...(r.isError !== undefined ? { isError: r.isError } : {}),
        latencyMs: r.latencyMs,
      });
    },
  };
  return { auditor, calls: sink };
}

describe('interceptProviderStream — allow path', () => {
  it('passes a tool_call through unchanged when policy allows', async () => {
    const events = scriptedTranscript()
      .toolCall('fs.read', { path: '/x' })
      .toolResult('ok')
      .done({ reason: 'completed' })
      .build();
    const provider = new FakeProvider({ events });
    const { auditor, calls } = makeAuditor();

    const out = await collect(
      interceptProviderStream(provider, makeRunInput(), {
        agent: makeAgent(),
        security: makeSecurity(),
        auditor,
      }),
    );

    expect(out.some((e) => e.type === 'approval_requested')).toBe(false);
    const calls0 = out.filter((e) => e.type === 'tool_call');
    expect(calls0).toHaveLength(1);
    expect(calls.calls[0]).toMatchObject({
      tool: 'fs.read',
      decision: 'allow',
      decidedBy: 'policy',
    });
    expect(calls.results[0]).toMatchObject({ toolCallId: 'tc_1' });
  });
});

describe('interceptProviderStream — deny path', () => {
  it('emits approval_requested then a synthetic error tool_result', async () => {
    const events = scriptedTranscript()
      .toolCall('fs.rm', { path: '/etc' })
      .done({ reason: 'completed' })
      .build();
    const provider = new FakeProvider({ events });
    const { auditor, calls } = makeAuditor();

    const out = await collect(
      interceptProviderStream(provider, makeRunInput(), {
        agent: makeAgent(),
        security: makeSecurity(),
        auditor,
      }),
    );

    const approval = out.find((e) => e.type === 'approval_requested');
    expect(approval).toBeDefined();
    const result = out.find((e) => e.type === 'tool_result');
    expect(result).toBeDefined();
    expect((result as Extract<RunEvent, { type: 'tool_result' }>).isError).toBe(true);
    expect(out.some((e) => e.type === 'tool_call')).toBe(false);

    expect(calls.calls[0]).toMatchObject({
      decision: 'deny',
      rule: 'risk_levels',
      decidedBy: 'policy',
    });
    expect(calls.results[0]).toMatchObject({ isError: true });
  });

  it('suppresses a later real tool_result for a denied tool call', async () => {
    const events = scriptedTranscript()
      .toolCall('fs.rm', { path: '/etc' })
      .toolResult('the provider tried anyway')
      .done({ reason: 'completed' })
      .build();
    const provider = new FakeProvider({ events });

    const out = await collect(
      interceptProviderStream(provider, makeRunInput(), {
        agent: makeAgent(),
        security: makeSecurity(),
      }),
    );

    const results = out.filter((e) => e.type === 'tool_result');
    expect(results).toHaveLength(1);
    expect((results[0] as Extract<RunEvent, { type: 'tool_result' }>).isError).toBe(true);
  });
});

describe('interceptProviderStream — approval_required path', () => {
  it('passes through when the resolver approves', async () => {
    const events = scriptedTranscript()
      .toolCall('fs.write', { path: '/x' })
      .toolResult('wrote')
      .done({ reason: 'completed' })
      .build();
    const provider = new FakeProvider({ events });
    const resolver: ApprovalResolver = vi.fn(async () => 'approve');
    const { auditor, calls } = makeAuditor();

    const out = await collect(
      interceptProviderStream(provider, makeRunInput(), {
        agent: makeAgent(),
        security: makeSecurity(),
        approvalResolver: resolver,
        auditor,
      }),
    );

    expect(out.filter((e) => e.type === 'approval_requested')).toHaveLength(1);
    expect(out.filter((e) => e.type === 'tool_call')).toHaveLength(1);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(calls.calls[0]).toMatchObject({
      decision: 'approval_required',
      decidedBy: 'human',
    });
  });

  it('emits a synthetic error result when the resolver rejects', async () => {
    const events = scriptedTranscript()
      .toolCall('fs.write', { path: '/x' })
      .toolResult('wrote')
      .done({ reason: 'completed' })
      .build();
    const provider = new FakeProvider({ events });
    const resolver: ApprovalResolver = vi.fn(async () => 'reject');
    const { auditor, calls } = makeAuditor();

    const out = await collect(
      interceptProviderStream(provider, makeRunInput(), {
        agent: makeAgent(),
        security: makeSecurity(),
        approvalResolver: resolver,
        auditor,
      }),
    );

    expect(out.filter((e) => e.type === 'approval_requested')).toHaveLength(1);
    expect(out.some((e) => e.type === 'tool_call')).toBe(false);
    const results = out.filter((e) => e.type === 'tool_result');
    expect(results).toHaveLength(1);
    expect((results[0] as Extract<RunEvent, { type: 'tool_result' }>).isError).toBe(true);
    expect(calls.calls[0]).toMatchObject({
      decision: 'approval_required',
    });
    expect(calls.calls[0]?.decidedBy).toBeUndefined();
  });

  it('defaults to reject when no resolver is supplied', async () => {
    const events = scriptedTranscript()
      .toolCall('fs.write', { path: '/x' })
      .done({ reason: 'completed' })
      .build();
    const provider = new FakeProvider({ events });

    const out = await collect(
      interceptProviderStream(provider, makeRunInput(), {
        agent: makeAgent(),
        security: makeSecurity(),
      }),
    );

    const results = out.filter((e) => e.type === 'tool_result');
    expect(results).toHaveLength(1);
    expect((results[0] as Extract<RunEvent, { type: 'tool_result' }>).isError).toBe(true);
  });
});

describe('interceptProviderStream — pass-through', () => {
  it('passes message and error events untouched', async () => {
    const events = scriptedTranscript()
      .message('assistant', 'hi')
      .error('something', true)
      .done({ reason: 'completed' })
      .build();
    const provider = new FakeProvider({ events });

    const out = await collect(
      interceptProviderStream(provider, makeRunInput(), {
        agent: makeAgent(),
        security: makeSecurity(),
      }),
    );

    expect(out.map((e) => e.type)).toEqual(['message', 'error', 'done']);
  });

  it('computes positive latency in onResult', async () => {
    const events: RunEvent[] = [
      { type: 'tool_call', toolCallId: 'tc_1', tool: 'fs.read', args: {}, timestamp: 100 },
      { type: 'tool_result', toolCallId: 'tc_1', result: 'ok', timestamp: 150 },
      {
        type: 'done',
        reason: 'completed',
        cost: null,
        tokens: null,
        durationMs: 0,
        timestamp: 160,
      },
    ];
    const provider = new FakeProvider({ events });
    const { auditor, calls } = makeAuditor();

    await collect(
      interceptProviderStream(provider, makeRunInput(), {
        agent: makeAgent(),
        security: makeSecurity(),
        auditor,
      }),
    );

    expect(calls.results[0]?.latencyMs).toBe(50);
  });
});

describe('stableHash', () => {
  it('is deterministic regardless of object-key order', () => {
    const a = stableHash({ a: 1, b: 2, c: { d: 3, e: 4 } });
    const b = stableHash({ c: { e: 4, d: 3 }, b: 2, a: 1 });
    expect(a).toBe(b);
  });

  it('distinguishes different values', () => {
    expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 2 }));
    expect(stableHash([1, 2, 3])).not.toBe(stableHash([3, 2, 1]));
  });

  it('handles primitives and null', () => {
    expect(stableHash(null)).toBe(stableHash(null));
    expect(stableHash('x')).not.toBe(stableHash('y'));
    expect(stableHash(1)).not.toBe(stableHash('1'));
  });
});
