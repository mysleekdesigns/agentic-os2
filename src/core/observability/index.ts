/**
 * Observability barrel (PRD §3 Phase 8).
 *
 * Re-exports types, span builders, the runtime emitter, the optional OTLP
 * exporter, and the `formatNullableNumber` renderer used by the CLI bundle's
 * `show` / `logs` surfaces.
 *
 * Downstream consumers should import only from this module so internal
 * layout can change without breaking the CLI.
 */

export type {
  AttributeValue,
  NullableNumberFormatter,
  SpanContext,
  SpanEvent,
  SpanKind,
  SpanLink,
  SpanRecord,
  SpanStatus,
} from './types.js';

export { addEvent, endSpan, genSpanId, genTraceId, newSpan, setAttribute } from './spans.js';
export type { NewSpanArgs } from './spans.js';

export { createSpanEmitter, spanToPersistedJson } from './emitter.js';
export type {
  SpanEmitter,
  SpanEmitterOptions,
  SpanExporter,
  StartArgs as SpanEmitterStartArgs,
} from './emitter.js';

export { createOtlpExporter } from './otlp.js';
export type { OtlpExporterOptions } from './otlp.js';

import type { AgentOsConfig } from '../../config/index.js';
import type { AgentOsDb } from '../../storage/db.js';
import { createSpanEmitter, type SpanEmitter, type SpanExporter } from './emitter.js';
import { createOtlpExporter } from './otlp.js';
import type { NullableNumberFormatter } from './types.js';

/**
 * Top-level factory that wires together the emitter + (optional) OTLP exporter
 * from the workspace `agent-os.config.yaml`. When `observability.traces` is
 * `false`, returns `{ emitter: undefined }` so callers can skip instrumentation
 * entirely.
 */
export interface ObservabilityRuntime {
  emitter?: SpanEmitter;
  exporter?: SpanExporter;
}

export interface CreateObservabilityOptions {
  clock?: () => number;
  errorLogger?: (msg: string, err: unknown) => void;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
}

export function createObservabilityFromConfig(
  config: AgentOsConfig,
  db: AgentOsDb,
  options: CreateObservabilityOptions = {},
): ObservabilityRuntime {
  if (!config.observability.traces) {
    return {};
  }

  let exporter: SpanExporter | undefined;
  const otlp = config.observability.otlp_exporter;
  if (otlp.enabled && otlp.endpoint.trim() !== '') {
    try {
      exporter = createOtlpExporter({
        endpoint: otlp.endpoint,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
    } catch (err) {
      // Falling back to local-only persistence is safer than failing the run.
      (options.errorLogger ?? (() => undefined))(
        'observability: failed to construct OTLP exporter',
        err,
      );
      exporter = undefined;
    }
  }

  const secretPatterns = config.security.secret_patterns;
  const emitter = createSpanEmitter({
    db,
    ...(exporter ? { exporter } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.errorLogger ? { errorLogger: options.errorLogger } : {}),
    ...(secretPatterns && secretPatterns.length > 0 ? { secretPatterns } : {}),
  });

  return { emitter, ...(exporter ? { exporter } : {}) };
}

/**
 * Renderer for token / cost numbers. Returns `"—"` for null / undefined so
 * tables never fabricate a zero value when the provider didn't surface usage
 * (Max mode). The CLI bundle imports this helper for its run-detail tables.
 *
 * `fractionDigits` controls float rounding (e.g. cost USD → 4 decimal places).
 * Units (when supplied) are appended with a non-breaking space (` `) so
 * column alignment stays consistent across rows where one value is dashed.
 */
export const formatNullableNumber: NullableNumberFormatter = (value, opts) => {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '—';
  }
  const digits = opts?.fractionDigits;
  const formatted =
    digits !== undefined && !Number.isInteger(value) ? value.toFixed(digits) : String(value);
  return opts?.unit ? `${formatted} ${opts.unit}` : formatted;
};
