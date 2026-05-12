import { describe, expect, it } from 'vitest';

import {
  flushAssistantBuffer,
  mapSdkEvent,
  newAssistantBuffer,
} from '../../../src/providers/claude_code_local/adapter.js';

describe('mapSdkEvent', () => {
  it('returns null for non-object inputs', () => {
    const buf = newAssistantBuffer();
    expect(mapSdkEvent(null, buf)).toBeNull();
    expect(mapSdkEvent(undefined, buf)).toBeNull();
    expect(mapSdkEvent('hello', buf)).toBeNull();
  });

  it('buffers assistant text deltas without emitting until flush', () => {
    const buf = newAssistantBuffer();
    const r1 = mapSdkEvent(
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello' }] },
      },
      buf,
    );
    const r2 = mapSdkEvent(
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: ', world.' }] },
      },
      buf,
    );
    expect(r1).toBeNull();
    expect(r2).toBeNull();
    expect(buf.text).toBe('Hello, world.');

    const flushed = flushAssistantBuffer(buf);
    expect(flushed).toMatchObject({
      type: 'message',
      role: 'assistant',
      text: 'Hello, world.',
    });
    expect(buf.text).toBe('');
  });

  it('flushes buffered assistant text before a tool_call event', () => {
    const buf = newAssistantBuffer();
    mapSdkEvent(
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Let me check the file.' }] },
      },
      buf,
    );

    const out = mapSdkEvent(
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_123',
              name: 'Read',
              input: { path: '/tmp/x' },
            },
          ],
        },
      },
      buf,
    );

    const events = Array.isArray(out) ? out : out !== null ? [out] : [];
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: 'message',
      role: 'assistant',
      text: 'Let me check the file.',
    });
    expect(events[1]).toMatchObject({
      type: 'tool_call',
      toolCallId: 'toolu_123',
      tool: 'Read',
      args: { path: '/tmp/x' },
    });
  });

  it('maps user message with tool_result content to a tool_result event', () => {
    const buf = newAssistantBuffer();
    const out = mapSdkEvent(
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_123',
              content: 'file body here',
            },
          ],
        },
      },
      buf,
    );

    const events = Array.isArray(out) ? out : out !== null ? [out] : [];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'tool_result',
      toolCallId: 'toolu_123',
      result: 'file body here',
    });
    expect(events[0]).not.toHaveProperty('isError');
  });

  it('sets isError on tool_result when SDK flags it', () => {
    const buf = newAssistantBuffer();
    const out = mapSdkEvent(
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't',
              content: 'boom',
              is_error: true,
            },
          ],
        },
      },
      buf,
    );

    const events = Array.isArray(out) ? out : out !== null ? [out] : [];
    expect(events[0]).toMatchObject({ type: 'tool_result', isError: true });
  });

  it('maps a permission_denied system message to approval_requested', () => {
    const buf = newAssistantBuffer();
    const out = mapSdkEvent(
      {
        type: 'system',
        subtype: 'permission_denied',
        tool_name: 'Bash',
        tool_use_id: 'toolu_999',
        decision_reason: 'risky shell',
      },
      buf,
    );

    const events = Array.isArray(out) ? out : out !== null ? [out] : [];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'approval_requested',
      tool: 'Bash',
      toolCallId: 'toolu_999',
      reason: 'risky shell',
    });
  });

  it('surfaces assistant error codes as error events', () => {
    const buf = newAssistantBuffer();
    const out = mapSdkEvent(
      {
        type: 'assistant',
        error: 'rate_limit',
        message: { content: [] },
      },
      buf,
    );

    const events = Array.isArray(out) ? out : out !== null ? [out] : [];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', recoverable: true });
  });

  it('emits an error for non-success result subtypes', () => {
    const buf = newAssistantBuffer();
    const out = mapSdkEvent(
      {
        type: 'result',
        subtype: 'error_during_execution',
        errors: ['something exploded'],
      },
      buf,
    );

    const events = Array.isArray(out) ? out : out !== null ? [out] : [];
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('returns null for a success result (outer loop emits done)', () => {
    const buf = newAssistantBuffer();
    const out = mapSdkEvent(
      {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0.01,
      },
      buf,
    );
    expect(out).toBeNull();
  });
});
