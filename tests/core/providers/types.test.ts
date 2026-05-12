import { describe, expect, it } from 'vitest';

import { defaultCapabilitiesFor } from '../../../src/core/providers/capabilities.js';
import type { RunEvent } from '../../../src/core/providers/types.js';

// Compile-time exhaustiveness check on RunEvent's discriminator. If a new
// variant is added without a case below, `_exhaustive: never` will fail to
// type-check.
function _assertRunEventExhaustive(event: RunEvent): string {
  switch (event.type) {
    case 'message':
      return event.role;
    case 'tool_call':
      return event.tool;
    case 'tool_result':
      return event.toolCallId;
    case 'approval_requested':
      return event.tool;
    case 'error':
      return event.message;
    case 'done':
      return event.reason;
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

describe('provider types', () => {
  it('claude_code_local has cost metering disabled', () => {
    expect(defaultCapabilitiesFor('claude_code_local').costMetering).toBe(false);
  });

  it('api providers have cost metering enabled', () => {
    expect(defaultCapabilitiesFor('anthropic_api').costMetering).toBe(true);
    expect(defaultCapabilitiesFor('openai_api').costMetering).toBe(true);
  });

  it('claude_code_local exposes mcp passthrough; api providers do not (yet)', () => {
    expect(defaultCapabilitiesFor('claude_code_local').mcp).toBe(true);
    expect(defaultCapabilitiesFor('anthropic_api').mcp).toBe(false);
    expect(defaultCapabilitiesFor('openai_api').mcp).toBe(false);
  });

  it('exhaustiveness helper compiles and dispatches every variant', () => {
    const events: RunEvent[] = [
      { type: 'message', role: 'assistant', text: 'hi', timestamp: 1 },
      { type: 'tool_call', toolCallId: 't1', tool: 'fs.read', args: {}, timestamp: 2 },
      { type: 'tool_result', toolCallId: 't1', result: 'ok', timestamp: 3 },
      {
        type: 'approval_requested',
        toolCallId: 't2',
        tool: 'fs.write',
        args: {},
        timestamp: 4,
      },
      { type: 'error', message: 'boom', timestamp: 5 },
      {
        type: 'done',
        reason: 'completed',
        cost: null,
        tokens: null,
        durationMs: 1,
        timestamp: 6,
      },
    ];
    expect(events.map(_assertRunEventExhaustive)).toEqual([
      'assistant',
      'fs.read',
      't1',
      'fs.write',
      'boom',
      'completed',
    ]);
  });
});
