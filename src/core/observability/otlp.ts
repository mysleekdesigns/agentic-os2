/**
 * Minimal OTLP/HTTP JSON span exporter (PRD §3 Phase 8).
 *
 * Off by default. When enabled via `observability.otlp_exporter.enabled`, the
 * emitter forwards a copy of every persisted span to `<endpoint>/v1/traces`.
 * No retry logic — observability is best-effort, and Phase 13+ owns
 * delivery guarantees. The emitter swallows our throws so a flaky collector
 * cannot break the run.
 *
 * Reference: https://opentelemetry.io/docs/specs/otlp/ (JSON encoding).
 * We hand-roll a small ResourceSpans envelope rather than vendoring the
 * full `@opentelemetry/api` packages to keep our dependency surface tight.
 */

import type { SpanExporter } from './emitter.js';
import type { AttributeValue, SpanRecord } from './types.js';

export interface OtlpExporterOptions {
  endpoint: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Service name reported in `resourceSpans[].resource.attributes`. */
  serviceName?: string;
  /** Override `fetch` for tests / non-Node runtimes. */
  fetchImpl?: typeof fetch;
}

interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values: OtlpAnyValue[] };
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  events: {
    timeUnixNano: string;
    name: string;
    attributes: OtlpKeyValue[];
  }[];
  status: { code: number; message?: string };
}

interface OtlpPayload {
  resourceSpans: {
    resource: { attributes: OtlpKeyValue[] };
    scopeSpans: {
      scope: { name: string; version: string };
      spans: OtlpSpan[];
    }[];
  }[];
}

const SCOPE_NAME = 'agent-os';
const SCOPE_VERSION = '0.0.1';

/** Convert ms → unix nanoseconds, encoded as a decimal string per OTLP. */
function toNanoString(ms: number): string {
  // BigInt math avoids precision loss for large ms.
  return (BigInt(Math.trunc(ms)) * 1_000_000n).toString();
}

function attrValue(value: AttributeValue): OtlpAnyValue {
  if (value === null) return { stringValue: '' };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map((v) => attrValue(v as AttributeValue)) } };
  }
  return { stringValue: String(value) };
}

function attrsToOtlp(attrs: Record<string, AttributeValue>): OtlpKeyValue[] {
  return Object.entries(attrs)
    .filter(([, v]) => v !== undefined)
    .map(([key, value]) => ({ key, value: attrValue(value) }));
}

function statusCode(status: SpanRecord['status']): number {
  // OTel Status: 0=UNSET, 1=OK, 2=ERROR. We map cancelled → ERROR.
  switch (status) {
    case 'ok':
      return 1;
    case 'error':
    case 'cancelled':
      return 2;
    case 'unset':
    default:
      return 0;
  }
}

function spanKindToOtel(kind: SpanRecord['kind']): number {
  // OTel SpanKind: 0=UNSPECIFIED, 1=INTERNAL, 2=SERVER, 3=CLIENT, 4=PRODUCER, 5=CONSUMER.
  // GenAI spans typically map to CLIENT (3) for tool/agent calls and
  // INTERNAL (1) for workflow scaffolding.
  switch (kind) {
    case 'tool_call':
    case 'agent':
    case 'retrieval':
      return 3;
    case 'workflow':
    default:
      return 1;
  }
}

function spanToOtlp(span: SpanRecord): OtlpSpan {
  const startNs = toNanoString(span.startTimeMs);
  const endNs = toNanoString(span.endTimeMs ?? span.startTimeMs);
  return {
    traceId: span.ctx.traceId,
    spanId: span.ctx.spanId,
    ...(span.ctx.parentSpanId ? { parentSpanId: span.ctx.parentSpanId } : {}),
    name: span.name,
    kind: spanKindToOtel(span.kind),
    startTimeUnixNano: startNs,
    endTimeUnixNano: endNs,
    attributes: attrsToOtlp(span.attributes),
    events: span.events.map((ev) => ({
      timeUnixNano: toNanoString(ev.timeMs),
      name: ev.name,
      attributes: attrsToOtlp(ev.attributes),
    })),
    status: { code: statusCode(span.status) },
  };
}

function buildPayload(spans: SpanRecord[], serviceName: string): OtlpPayload {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: attrsToOtlp({ 'service.name': serviceName }),
        },
        scopeSpans: [
          {
            scope: { name: SCOPE_NAME, version: SCOPE_VERSION },
            spans: spans.map(spanToOtlp),
          },
        ],
      },
    ],
  };
}

export function createOtlpExporter(opts: OtlpExporterOptions): SpanExporter {
  if (!opts.endpoint || opts.endpoint.trim() === '') {
    throw new Error('createOtlpExporter: endpoint is required');
  }
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('createOtlpExporter: no fetch implementation available');
  }
  const url = opts.endpoint.replace(/\/$/, '') + '/v1/traces';
  const serviceName = opts.serviceName ?? 'agent-os';
  const timeoutMs = opts.timeoutMs ?? 5_000;

  return {
    async export(spans: SpanRecord[]): Promise<void> {
      if (spans.length === 0) return;
      const payload = buildPayload(spans, serviceName);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(opts.headers ?? {}),
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) {
        throw new Error(
          `OTLP exporter: HTTP ${response.status} ${response.statusText} from ${url}`,
        );
      }
    },
    async shutdown(): Promise<void> {
      // No internal queue — nothing to drain.
    },
  };
}
