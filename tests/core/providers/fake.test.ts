import { describe, expect, it } from 'vitest';

import { FakeProvider, scriptedTranscript } from '../../../src/core/providers/fake.js';
import type { AgentRunInput, RunEvent } from '../../../src/core/providers/types.js';

const baseInput: AgentRunInput = {
  agentId: 'a1',
  goal: 'do a thing',
  instructions: '# agent body',
  workspaceRoot: '/tmp/ws',
};

async function collect(iter: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

describe('FakeProvider', () => {
  it('yields scripted events in order', async () => {
    const events = scriptedTranscript()
      .message('assistant', 'hello')
      .toolCall('fs.read', { path: 'README.md' })
      .toolResult({ ok: true })
      .done({ durationMs: 5 })
      .build();
    const provider = new FakeProvider({ events });
    const got = await collect(provider.run(baseInput));
    expect(got.map((e) => e.type)).toEqual(['message', 'tool_call', 'tool_result', 'done']);
    expect(got[3]).toMatchObject({ type: 'done', reason: 'completed', durationMs: 5 });
  });

  it('auto-appends a done event when the script omits one', async () => {
    const events = scriptedTranscript().message('assistant', 'short').build();
    const provider = new FakeProvider({ events });
    const got = await collect(provider.run(baseInput));
    expect(got).toHaveLength(2);
    expect(got[1]).toMatchObject({
      type: 'done',
      reason: 'completed',
      cost: null,
      tokens: null,
    });
  });

  it('respects delayMs between yielded events', async () => {
    const events = scriptedTranscript()
      .message('assistant', 'a')
      .message('assistant', 'b')
      .done()
      .build();
    const provider = new FakeProvider({ events, delayMs: 5 });
    const t0 = Date.now();
    await collect(provider.run(baseInput));
    const elapsed = Date.now() - t0;
    // 3 yielded events => 3 delays of 5ms; allow generous slack on slow CI.
    expect(elapsed).toBeGreaterThanOrEqual(10);
  });

  it('aborting mid-stream yields a cancelled done and stops', async () => {
    const events = scriptedTranscript()
      .message('assistant', 'one')
      .message('assistant', 'two')
      .message('assistant', 'three')
      .done()
      .build();
    const controller = new AbortController();
    const provider = new FakeProvider({ events, delayMs: 5 });

    const iter = provider.run({ ...baseInput, signal: controller.signal });
    const got: RunEvent[] = [];
    for await (const ev of iter) {
      got.push(ev);
      if (got.length === 1) controller.abort();
    }

    const last = got[got.length - 1];
    expect(last?.type).toBe('done');
    if (last?.type === 'done') {
      expect(last.reason).toBe('cancelled');
      expect(last.cost).toBeNull();
      expect(last.tokens).toBeNull();
    }
    // The scripted "three" message must not have been yielded.
    expect(got.find((e) => e.type === 'message' && e.text === 'three')).toBeUndefined();
  });

  it('overrides capabilities when constructor opts provide them', () => {
    const provider = new FakeProvider({
      events: [],
      capabilities: { costMetering: true, mcp: false },
    });
    expect(provider.capabilities.costMetering).toBe(true);
    expect(provider.capabilities.mcp).toBe(false);
    // Untouched flag falls back to the claude_code_local default.
    expect(provider.capabilities.streaming).toBe(true);
  });
});

describe('scriptedTranscript builder', () => {
  it('produces a well-shaped event array with stable ordering', () => {
    const events = scriptedTranscript()
      .message('assistant', 'hi')
      .toolCall('mcp.crawlforge.search_web', { q: 'x' })
      .toolResult({ hits: 1 })
      .approvalRequested('fs.write', { path: 'a' }, { reason: 'destructive' })
      .error('warn', true)
      .done()
      .build();

    expect(events.map((e) => e.type)).toEqual([
      'message',
      'tool_call',
      'tool_result',
      'approval_requested',
      'error',
      'done',
    ]);
    // toolResult defaults to the most recent toolCall id.
    const call = events[1];
    const result = events[2];
    if (call.type === 'tool_call' && result.type === 'tool_result') {
      expect(result.toolCallId).toBe(call.toolCallId);
    }
    // Timestamps are monotonically increasing.
    for (let i = 1; i < events.length; i += 1) {
      expect(events[i].timestamp).toBeGreaterThan(events[i - 1].timestamp);
    }
  });
});
