/**
 * Observability type contracts (PRD §3 Phase 8).
 *
 * The Agent OS observability layer emits OpenTelemetry-shaped spans for every
 * workflow / agent / tool call / retrieval. These types are pure value
 * material — no runtime logic, no I/O. They are imported by the runtime
 * emitter, the optional OTLP exporter, and the CLI's `show` / `logs`
 * commands (which live in a separate bundle).
 *
 * Field naming follows the OTel GenAI semantic conventions:
 *   - `gen_ai.system`             — provider id (e.g. claude_code_local)
 *   - `gen_ai.operation.name`     — chat / text_completion / etc
 *   - `gen_ai.request.model`      — requested model name
 *   - `gen_ai.response.model`     — actual model name (optional)
 *   - `gen_ai.usage.input_tokens` — nullable in Max mode
 *   - `gen_ai.usage.output_tokens`— nullable in Max mode
 *   - `gen_ai.usage.cost_usd`     — extension; nullable in Max mode
 *
 * Reference: https://opentelemetry.io/docs/specs/semconv/gen-ai/
 */

/** Span kinds emitted by Agent OS. */
export type SpanKind = 'workflow' | 'agent' | 'tool_call' | 'retrieval';

/** Span status, mirroring the OTel `Status.Code` enum (plus our `cancelled`). */
export type SpanStatus = 'unset' | 'ok' | 'error' | 'cancelled';

/**
 * Identity tuple for a span. `traceId` and `spanId` use OTel's hex encoding
 * (16-byte / 8-byte respectively, lowercase hex).
 */
export interface SpanContext {
  /** 16-byte hex (32 chars) per OTel. */
  traceId: string;
  /** 8-byte hex (16 chars) per OTel. */
  spanId: string;
  /** Optional parent span id, same encoding as `spanId`. */
  parentSpanId?: string;
  /** Foreign key to `runs.id`. Every span is tied to exactly one run. */
  runId: string;
}

/**
 * Concrete attribute value types supported by OTel attributes (subset). We
 * stay close to the spec so the OTLP exporter mapping is trivial.
 */
export type AttributeValue = string | number | boolean | null | string[] | number[] | boolean[];

/** Span-level event (e.g. "tool.args", "error"). */
export interface SpanEvent {
  name: string;
  /** Unix epoch milliseconds. */
  timeMs: number;
  attributes: Record<string, AttributeValue>;
}

/** Cross-trace link. Not used today; included for round-trip compatibility. */
export interface SpanLink {
  traceId: string;
  spanId: string;
  attributes?: Record<string, AttributeValue>;
}

/**
 * Full span record. This is the in-memory representation; on `end()` the
 * emitter serializes it (verbatim) into `traces.otel_span_json` so the CLI
 * `show` command can deserialize and render it. The JSON shape is stable.
 */
export interface SpanRecord {
  ctx: SpanContext;
  kind: SpanKind;
  name: string;
  /** Unix epoch milliseconds. OTel uses nanoseconds; we keep ms internally. */
  startTimeMs: number;
  endTimeMs?: number;
  status: SpanStatus;
  attributes: Record<string, AttributeValue>;
  events: SpanEvent[];
  links: SpanLink[];
}

/**
 * Renderer helper signature. Returns `"—"` for null/undefined so tables don't
 * fabricate zero/cost data when the provider doesn't surface usage (Max mode).
 */
export type NullableNumberFormatter = (
  value: number | null | undefined,
  opts?: { unit?: string; fractionDigits?: number },
) => string;
