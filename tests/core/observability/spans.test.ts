/**
 * Pure span-builder tests (PRD §3 Phase 8).
 */

import { describe, expect, it } from 'vitest';

import {
  addEvent,
  endSpan,
  genSpanId,
  genTraceId,
  newSpan,
  setAttribute,
} from '../../../src/core/observability/index.js';
import type { SpanContext } from '../../../src/core/observability/index.js';

const HEX = /^[0-9a-f]+$/;

function makeCtx(): SpanContext {
  return {
    traceId: genTraceId(),
    spanId: genSpanId(),
    runId: 'run-1',
  };
}

describe('observability/spans', () => {
  it('genTraceId returns a 32-char hex string', () => {
    const id = genTraceId();
    expect(id).toHaveLength(32);
    expect(HEX.test(id)).toBe(true);
  });

  it('genSpanId returns a 16-char hex string', () => {
    const id = genSpanId();
    expect(id).toHaveLength(16);
    expect(HEX.test(id)).toBe(true);
  });

  it('genTraceId values are unique across calls', () => {
    const set = new Set<string>();
    for (let i = 0; i < 128; i += 1) set.add(genTraceId());
    expect(set.size).toBe(128);
  });

  it('newSpan initialises with empty events/links and unset status', () => {
    const ctx = makeCtx();
    const span = newSpan({ kind: 'agent', name: 'agent:foo', ctx });
    expect(span.kind).toBe('agent');
    expect(span.name).toBe('agent:foo');
    expect(span.status).toBe('unset');
    expect(span.events).toEqual([]);
    expect(span.links).toEqual([]);
    expect(span.attributes).toEqual({});
    expect(span.endTimeMs).toBeUndefined();
  });

  it('newSpan accepts an explicit start time and attribute bag', () => {
    const ctx = makeCtx();
    const span = newSpan({
      kind: 'tool_call',
      name: 'tool:read',
      ctx,
      startTimeMs: 1_700_000_000_000,
      attributes: { 'gen_ai.tool.name': 'read' },
    });
    expect(span.startTimeMs).toBe(1_700_000_000_000);
    expect(span.attributes['gen_ai.tool.name']).toBe('read');
  });

  it('addEvent appends an event with attributes', () => {
    const span = newSpan({ kind: 'agent', name: 'agent:x', ctx: makeCtx() });
    addEvent(span, 'tool.args', { hash: 'abc' }, 1_700_000_000_001);
    expect(span.events).toHaveLength(1);
    expect(span.events[0]).toEqual({
      name: 'tool.args',
      timeMs: 1_700_000_000_001,
      attributes: { hash: 'abc' },
    });
  });

  it('setAttribute and endSpan mutate the record in place', () => {
    const span = newSpan({ kind: 'workflow', name: 'wf:foo', ctx: makeCtx() });
    setAttribute(span, 'agent_os.run_id', 'run-1');
    endSpan(span, 'ok', { 'gen_ai.usage.input_tokens': 42 }, 1_700_000_000_500);
    expect(span.status).toBe('ok');
    expect(span.endTimeMs).toBe(1_700_000_000_500);
    expect(span.attributes['agent_os.run_id']).toBe('run-1');
    expect(span.attributes['gen_ai.usage.input_tokens']).toBe(42);
  });
});
