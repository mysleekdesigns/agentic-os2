/**
 * Pure span builders (PRD §3 Phase 8).
 *
 * These helpers construct and mutate `SpanRecord` values; they perform no
 * I/O. The runtime emitter in `./emitter.ts` is the only module that
 * persists spans to SQLite or hands them to the OTLP exporter.
 *
 * OTel GenAI semconv attribute names this module knows about:
 *   - gen_ai.system               (provider id)
 *   - gen_ai.operation.name       (chat / text_completion / tool_call / retrieval)
 *   - gen_ai.request.model        (requested model)
 *   - gen_ai.response.model       (resolved model, optional)
 *   - gen_ai.usage.input_tokens   (nullable; null in Max mode)
 *   - gen_ai.usage.output_tokens  (nullable; null in Max mode)
 *   - gen_ai.usage.cost_usd       (extension; nullable in Max mode)
 *   - gen_ai.tool.name            (per OTel GenAI Tools spec)
 *
 * Agent-OS-specific extensions all use the `agent_os.*` prefix.
 */

import { randomBytes } from 'node:crypto';

import type { AttributeValue, SpanContext, SpanKind, SpanRecord, SpanStatus } from './types.js';

/** Generate a 16-byte hex trace id (32 chars). */
export function genTraceId(): string {
  return randomBytes(16).toString('hex');
}

/** Generate an 8-byte hex span id (16 chars). */
export function genSpanId(): string {
  return randomBytes(8).toString('hex');
}

export interface NewSpanArgs {
  kind: SpanKind;
  name: string;
  ctx: SpanContext;
  attributes?: Record<string, AttributeValue>;
  startTimeMs?: number;
}

/**
 * Build a brand-new span. Status defaults to `'unset'`; events/links are
 * empty arrays you can mutate via `addEvent` / direct push.
 */
export function newSpan(args: NewSpanArgs): SpanRecord {
  return {
    ctx: args.ctx,
    kind: args.kind,
    name: args.name,
    startTimeMs: args.startTimeMs ?? Date.now(),
    status: 'unset',
    attributes: { ...(args.attributes ?? {}) },
    events: [],
    links: [],
  };
}

/** Append a span-level event. Mutates `span.events` in place. */
export function addEvent(
  span: SpanRecord,
  name: string,
  attributes?: Record<string, AttributeValue>,
  timeMs?: number,
): void {
  span.events.push({
    name,
    timeMs: timeMs ?? Date.now(),
    attributes: { ...(attributes ?? {}) },
  });
}

/** Set / overwrite a span attribute. Mutates in place. */
export function setAttribute(span: SpanRecord, key: string, value: AttributeValue): void {
  span.attributes[key] = value;
}

/**
 * End a span: stamps `endTimeMs`, finalises `status`, merges any
 * end-time attributes. Idempotent — calling twice has no extra effect
 * beyond bumping `endTimeMs`/`status` to the latest values.
 */
export function endSpan(
  span: SpanRecord,
  status: SpanStatus,
  attributes?: Record<string, AttributeValue>,
  endTimeMs?: number,
): void {
  span.endTimeMs = endTimeMs ?? Date.now();
  span.status = status;
  if (attributes) {
    for (const [k, v] of Object.entries(attributes)) {
      span.attributes[k] = v;
    }
  }
}
