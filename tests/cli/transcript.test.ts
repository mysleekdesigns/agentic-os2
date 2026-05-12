import { describe, expect, it } from 'vitest';

import type { RunEvent } from '../../src/core/providers/index.js';
import { renderEvent, renderJsonLine } from '../../src/cli/transcript.js';

describe('renderEvent', () => {
  it('renders an assistant message', () => {
    const ev: RunEvent = {
      type: 'message',
      role: 'assistant',
      text: 'Hello, world.',
      timestamp: 1,
    };
    expect(renderEvent(ev)).toBe('  → assistant: Hello, world.');
  });

  it('renders a user message', () => {
    const ev: RunEvent = {
      type: 'message',
      role: 'user',
      text: 'Do the thing.',
      timestamp: 1,
    };
    expect(renderEvent(ev)).toBe('  → user: Do the thing.');
  });

  it('renders a tool_call with one-line stringified args', () => {
    const ev: RunEvent = {
      type: 'tool_call',
      toolCallId: 'tc_1',
      tool: 'fs.read',
      args: { path: '/etc/hosts' },
      timestamp: 2,
    };
    expect(renderEvent(ev)).toBe('  • tool_call fs.read({"path":"/etc/hosts"})');
  });

  it('renders a successful tool_result', () => {
    const ev: RunEvent = {
      type: 'tool_result',
      toolCallId: 'tc_1',
      result: 'ok',
      timestamp: 3,
    };
    expect(renderEvent(ev)).toBe('  ✓ tool_result tc_1');
  });

  it('renders a failed tool_result', () => {
    const ev: RunEvent = {
      type: 'tool_result',
      toolCallId: 'tc_1',
      result: 'boom',
      isError: true,
      timestamp: 3,
    };
    expect(renderEvent(ev)).toBe('  ✗ tool_result tc_1 (error)');
  });

  it('renders an approval_requested event with a reason', () => {
    const ev: RunEvent = {
      type: 'approval_requested',
      toolCallId: 'tc_2',
      tool: 'fs.write',
      args: { path: '/tmp/x' },
      reason: 'risky tool',
      timestamp: 4,
    };
    expect(renderEvent(ev)).toBe('  ⏸ approval_requested fs.write — risky tool');
  });

  it('renders an approval_requested event without a reason', () => {
    const ev: RunEvent = {
      type: 'approval_requested',
      toolCallId: 'tc_2',
      tool: 'fs.write',
      args: {},
      timestamp: 4,
    };
    expect(renderEvent(ev)).toBe('  ⏸ approval_requested fs.write');
  });

  it('renders an error event', () => {
    const ev: RunEvent = {
      type: 'error',
      message: 'something exploded',
      timestamp: 5,
    };
    expect(renderEvent(ev)).toBe('  ✗ error: something exploded');
  });

  it('renders a done event with em-dash for null cost/tokens', () => {
    const ev: RunEvent = {
      type: 'done',
      reason: 'completed',
      cost: null,
      tokens: null,
      durationMs: 123,
      timestamp: 6,
    };
    const out = renderEvent(ev);
    expect(out).toContain('— done (completed) in 123ms');
    expect(out).toContain('cost: —');
    expect(out).toContain('tokens: —');
    // No fabricated zeros.
    expect(out).not.toMatch(/cost:\s*0/);
    expect(out).not.toMatch(/tokens:\s*0/);
  });

  it('renders a done event with real cost/tokens when present', () => {
    const ev: RunEvent = {
      type: 'done',
      reason: 'completed',
      cost: 0.42,
      tokens: { input: 100, output: 200 },
      durationMs: 50,
      timestamp: 7,
    };
    const out = renderEvent(ev);
    expect(out).toContain('cost: 0.42');
    expect(out).toContain('tokens: in=100 out=200');
  });

  it('renders done with cancelled and error reasons', () => {
    const cancelled: RunEvent = {
      type: 'done',
      reason: 'cancelled',
      cost: null,
      tokens: null,
      durationMs: 10,
      timestamp: 8,
    };
    expect(renderEvent(cancelled)).toContain('— done (cancelled) in 10ms');

    const errored: RunEvent = {
      type: 'done',
      reason: 'error',
      cost: null,
      tokens: null,
      durationMs: 20,
      timestamp: 9,
    };
    expect(renderEvent(errored)).toContain('— done (error) in 20ms');
  });

  it('wraps output in ANSI escapes when color is enabled', () => {
    const ev: RunEvent = {
      type: 'message',
      role: 'assistant',
      text: 'hi',
      timestamp: 1,
    };
    const out = renderEvent(ev, { color: true });
    expect(out).toContain('\x1b[');
    expect(out).toContain('hi');
  });

  it('emits no ANSI escapes by default', () => {
    const ev: RunEvent = {
      type: 'message',
      role: 'assistant',
      text: 'hi',
      timestamp: 1,
    };
    expect(renderEvent(ev)).not.toContain('\x1b[');
  });
});

describe('renderJsonLine', () => {
  it('round-trips every event kind through JSON.parse', () => {
    const events: RunEvent[] = [
      { type: 'message', role: 'assistant', text: 'hello', timestamp: 1 },
      { type: 'tool_call', toolCallId: 'tc_1', tool: 'fs.read', args: { x: 1 }, timestamp: 2 },
      { type: 'tool_result', toolCallId: 'tc_1', result: 'ok', timestamp: 3 },
      {
        type: 'approval_requested',
        toolCallId: 'tc_2',
        tool: 'fs.write',
        args: {},
        reason: 'risky',
        timestamp: 4,
      },
      { type: 'error', message: 'boom', timestamp: 5 },
      {
        type: 'done',
        reason: 'completed',
        cost: null,
        tokens: null,
        durationMs: 7,
        timestamp: 6,
      },
    ];

    for (const ev of events) {
      const line = renderJsonLine(ev);
      expect(line).not.toContain('\n');
      const parsed = JSON.parse(line) as RunEvent;
      expect(parsed).toEqual(ev);
    }
  });
});
