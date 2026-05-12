/**
 * Runtime span emitter (PRD §3 Phase 8).
 *
 * The emitter is the single seam through which the workflow executor, the
 * tool-call interceptor, and (in later phases) provider adapters and
 * memory-search callers record OpenTelemetry-shaped spans. It persists every
 * span to `traces.otel_span_json` (one row per span) and optionally hands a
 * copy to an out-of-process OTLP exporter.
 *
 * Adoption note: `searchMemory` callers (today: the CLI / future: agents via
 * providers) should wrap their lookups with
 *   const ctx = emitter.start({ kind: 'retrieval', ... });
 *   try { ... } finally { emitter.end(ctx, 'ok'); }
 * Phase 8 does NOT modify `src/core/memory/*`; the API surface is exposed
 * here so upstream callers can adopt it in Phase 11+ without further engine
 * changes.
 *
 * Best-effort by design: observability never throws to the caller. Persist
 * failures are logged through `errorLogger` and swallowed. Exporter failures
 * are caught and dropped (the local SQLite row is the source of truth).
 */

import type { AgentOsDb } from '../../storage/db.js';
import { traces } from '../../storage/schema.js';
import { genSpanId, genTraceId, newSpan, addEvent, endSpan } from './spans.js';
import type { AttributeValue, SpanContext, SpanKind, SpanRecord, SpanStatus } from './types.js';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** Out-of-process span exporter (e.g. OTLP/HTTP). */
export interface SpanExporter {
  export(spans: SpanRecord[]): Promise<void>;
  shutdown?(): Promise<void>;
}

export interface SpanEmitterOptions {
  db: AgentOsDb;
  /** Optional OTLP exporter. When omitted, spans persist locally only. */
  exporter?: SpanExporter;
  /** Override for tests; defaults to `Date.now`. */
  clock?: () => number;
  /** Where to send swallowed errors. Defaults to a silent sink. */
  errorLogger?: (msg: string, err: unknown) => void;
}

export interface StartArgs {
  kind: SpanKind;
  name: string;
  runId: string;
  parent?: SpanContext;
  attributes?: Record<string, AttributeValue>;
}

export interface SpanEmitter {
  /** Begin a new span. Returns its identity tuple. */
  start(args: StartArgs): SpanContext;
  /** Append a span-level event. No-op for unknown contexts. */
  recordEvent(ctx: SpanContext, name: string, attributes?: Record<string, AttributeValue>): void;
  /** Set or overwrite a span attribute. No-op for unknown contexts. */
  setAttribute(ctx: SpanContext, key: string, value: AttributeValue): void;
  /**
   * Finalise a span: stamp end time, set status, persist to `traces`, and
   * (best-effort) hand it to the exporter. Calling twice with the same ctx
   * is a no-op after the first call.
   */
  end(ctx: SpanContext, status: SpanStatus, attributes?: Record<string, AttributeValue>): void;
  /**
   * Finalise any still-open spans (marking them `'cancelled'`) and wait for
   * the exporter to drain. Safe to call multiple times. Always resolves.
   */
  flush(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * The stable serialised shape persisted to `traces.otel_span_json`. The CLI
 * `agent-os show` command (separate bundle) parses this exact envelope.
 */
interface PersistedSpan {
  context: SpanContext;
  kind: SpanKind;
  name: string;
  startTimeMs: number;
  endTimeMs: number | null;
  status: SpanStatus;
  attributes: Record<string, AttributeValue>;
  events: SpanRecord['events'];
  links: SpanRecord['links'];
}

export function createSpanEmitter(opts: SpanEmitterOptions): SpanEmitter {
  const clock = opts.clock ?? Date.now;
  const log: (msg: string, err: unknown) => void = opts.errorLogger ?? (() => undefined);
  const live = new Map<string, SpanRecord>();
  const pendingExports: Promise<unknown>[] = [];

  const persist = (span: SpanRecord): void => {
    try {
      const payload: PersistedSpan = {
        context: span.ctx,
        kind: span.kind,
        name: span.name,
        startTimeMs: span.startTimeMs,
        endTimeMs: span.endTimeMs ?? null,
        status: span.status,
        attributes: span.attributes,
        events: span.events,
        links: span.links,
      };
      const json = JSON.stringify(payload);
      // `onConflictDoNothing` keeps `flush()` idempotent — re-running a
      // partially-persisted span (e.g. after a process crash) does not raise.
      opts.db
        .insert(traces)
        .values({
          id: span.ctx.spanId,
          runId: span.ctx.runId,
          otelSpanJson: json,
        })
        .onConflictDoNothing()
        .run();
    } catch (err) {
      log(`observability: failed to persist span ${span.ctx.spanId}`, err);
    }
    if (opts.exporter) {
      try {
        const p = Promise.resolve(opts.exporter.export([span])).catch((err) => {
          log(`observability: exporter failed for span ${span.ctx.spanId}`, err);
        });
        pendingExports.push(p);
      } catch (err) {
        log(`observability: exporter threw for span ${span.ctx.spanId}`, err);
      }
    }
  };

  const start: SpanEmitter['start'] = (args) => {
    const ctx: SpanContext = {
      traceId: args.parent?.traceId ?? genTraceId(),
      spanId: genSpanId(),
      runId: args.runId,
      ...(args.parent ? { parentSpanId: args.parent.spanId } : {}),
    };
    const span = newSpan({
      kind: args.kind,
      name: args.name,
      ctx,
      ...(args.attributes ? { attributes: args.attributes } : {}),
      startTimeMs: clock(),
    });
    live.set(ctx.spanId, span);
    return ctx;
  };

  const recordEvent: SpanEmitter['recordEvent'] = (ctx, name, attributes) => {
    const span = live.get(ctx.spanId);
    if (!span) return;
    addEvent(span, name, attributes, clock());
  };

  const setAttribute: SpanEmitter['setAttribute'] = (ctx, key, value) => {
    const span = live.get(ctx.spanId);
    if (!span) return;
    span.attributes[key] = value;
  };

  const end: SpanEmitter['end'] = (ctx, status, attributes) => {
    const span = live.get(ctx.spanId);
    if (!span) return;
    endSpan(span, status, attributes, clock());
    live.delete(ctx.spanId);
    persist(span);
  };

  const flush: SpanEmitter['flush'] = async () => {
    // Cancel any open spans first; persist deletes them from `live`.
    for (const span of [...live.values()]) {
      endSpan(span, 'cancelled', undefined, clock());
      live.delete(span.ctx.spanId);
      persist(span);
    }
    // Drain in-flight exporter sends. We snapshot the array so concurrent
    // appenders during await don't keep us looping forever.
    const inFlight = pendingExports.splice(0, pendingExports.length);
    await Promise.allSettled(inFlight);
    if (opts.exporter?.shutdown) {
      try {
        await opts.exporter.shutdown();
      } catch (err) {
        log('observability: exporter shutdown failed', err);
      }
    }
  };

  return { start, recordEvent, setAttribute, end, flush };
}

// ---------------------------------------------------------------------------
// Internal helper used by the OTLP exporter so persistence + export stay
// in lockstep on the JSON shape.
// ---------------------------------------------------------------------------

export function spanToPersistedJson(span: SpanRecord): string {
  const payload: PersistedSpan = {
    context: span.ctx,
    kind: span.kind,
    name: span.name,
    startTimeMs: span.startTimeMs,
    endTimeMs: span.endTimeMs ?? null,
    status: span.status,
    attributes: span.attributes,
    events: span.events,
    links: span.links,
  };
  return JSON.stringify(payload);
}
