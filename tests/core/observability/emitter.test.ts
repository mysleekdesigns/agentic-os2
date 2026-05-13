/**
 * Runtime span emitter tests (PRD §3 Phase 8).
 *
 * Verifies:
 *  - spans land in `traces.otel_span_json` (one row per span)
 *  - the persisted JSON envelope matches the stable shape the CLI bundle expects
 *  - flush() finalises any still-open spans as `cancelled`
 *  - exporter failures are swallowed (best-effort)
 *  - persistence errors are surfaced via `errorLogger` (best-effort)
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

import { openDatabase, type AgentOsDb } from '../../../src/storage/db.js';
import { runMigrations } from '../../../src/storage/migrate.js';
import { agents, runs, traces } from '../../../src/storage/schema.js';
import {
  createObservabilityFromConfig,
  createSpanEmitter,
  formatNullableNumber,
  type SpanExporter,
} from '../../../src/core/observability/index.js';
import { AgentOsConfigSchema } from '../../../src/config/index.js';

interface Harness {
  root: string;
  db: AgentOsDb;
}

async function makeHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-obs-'));
  const db = openDatabase(join(root, 'agent-os.sqlite'));
  await runMigrations(db, { log: () => undefined });
  await db.insert(agents).values({
    id: 'tester',
    version: '1',
    definitionPath: '',
    hash: '',
    createdAt: new Date(),
  });
  await db.insert(runs).values({
    id: 'run-1',
    agentId: 'tester',
    status: 'running',
    startedAt: new Date(),
    provider: 'fake',
    model: 'fake-model',
  });
  return { root, db };
}

async function tearDown(h: Harness): Promise<void> {
  try {
    h.db.$sqlite.close();
  } catch {
    /* already closed */
  }
  await rm(h.root, { recursive: true, force: true });
}

describe('createSpanEmitter — persistence', () => {
  let h: Harness;
  beforeEach(async () => (h = await makeHarness()));
  afterEach(async () => tearDown(h));

  it('persists one row per ended span with stable JSON shape', async () => {
    const emitter = createSpanEmitter({ db: h.db, clock: () => 1_700_000_000_000 });
    const wf = emitter.start({
      kind: 'workflow',
      name: 'wf:demo',
      runId: 'run-1',
      attributes: { 'agent_os.workflow_id': 'demo' },
    });
    const agent = emitter.start({
      kind: 'agent',
      name: 'agent:lead',
      runId: 'run-1',
      parent: wf,
      attributes: { 'gen_ai.request.model': 'fake-model' },
    });
    emitter.recordEvent(agent, 'tool.args', { hash: 'abc' });
    emitter.end(agent, 'ok');
    emitter.end(wf, 'ok', { 'gen_ai.usage.input_tokens': null });
    await emitter.flush();

    const rows = await h.db.select().from(traces).where(eq(traces.runId, 'run-1'));
    expect(rows).toHaveLength(2);

    const parsed = rows.map((r) => JSON.parse(r.otelSpanJson));
    const wfPayload = parsed.find((p) => p.kind === 'workflow')!;
    const agentPayload = parsed.find((p) => p.kind === 'agent')!;

    expect(wfPayload).toMatchObject({
      kind: 'workflow',
      name: 'wf:demo',
      status: 'ok',
      startTimeMs: 1_700_000_000_000,
      endTimeMs: 1_700_000_000_000,
      attributes: {
        'agent_os.workflow_id': 'demo',
        'gen_ai.usage.input_tokens': null,
      },
      events: [],
      links: [],
    });
    expect(wfPayload.context).toEqual({
      traceId: wf.traceId,
      spanId: wf.spanId,
      runId: 'run-1',
    });

    expect(agentPayload.context.parentSpanId).toBe(wf.spanId);
    expect(agentPayload.context.traceId).toBe(wf.traceId);
    expect(agentPayload.events).toEqual([
      { name: 'tool.args', timeMs: 1_700_000_000_000, attributes: { hash: 'abc' } },
    ]);
  });

  it('flush() finalises still-open spans as cancelled', async () => {
    const emitter = createSpanEmitter({ db: h.db, clock: () => 1_700_000_000_000 });
    emitter.start({ kind: 'workflow', name: 'wf:abandoned', runId: 'run-1' });
    await emitter.flush();

    const rows = await h.db.select().from(traces).where(eq(traces.runId, 'run-1'));
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0]!.otelSpanJson);
    expect(payload.status).toBe('cancelled');
  });

  it('forwards ended spans to the exporter', async () => {
    const exported: string[] = [];
    const exporter: SpanExporter = {
      async export(spans) {
        for (const s of spans) exported.push(s.ctx.spanId);
      },
    };
    const emitter = createSpanEmitter({ db: h.db, exporter });
    const ctx = emitter.start({ kind: 'agent', name: 'agent:e', runId: 'run-1' });
    emitter.end(ctx, 'ok');
    await emitter.flush();
    expect(exported).toEqual([ctx.spanId]);
  });

  it('exporter receives scrubbed span attributes (PRD §2.5 secret_patterns)', async () => {
    const exportedAttrs: Record<string, unknown>[] = [];
    const exportedEventAttrs: Record<string, unknown>[] = [];
    const exporter: SpanExporter = {
      async export(spans) {
        for (const s of spans) {
          exportedAttrs.push(s.attributes);
          for (const evt of s.events) exportedEventAttrs.push(evt.attributes);
        }
      },
    };
    const emitter = createSpanEmitter({
      db: h.db,
      exporter,
      secretPatterns: ['SECRET_[A-Z0-9]+'],
    });
    const ctx = emitter.start({
      kind: 'tool_call',
      name: 'tool:scrub',
      runId: 'run-scrub',
      attributes: { note: 'leaks SECRET_ABC123 here' },
    });
    emitter.recordEvent(ctx, 'evt', { also: 'SECRET_XYZ999' });
    emitter.end(ctx, 'ok');
    await emitter.flush();
    expect(exportedAttrs[0]!.note).toBe('leaks <redacted> here');
    expect(exportedEventAttrs[0]!.also).toBe('<redacted>');
  });

  it('swallows exporter errors via errorLogger', async () => {
    const logged: { msg: string; err: unknown }[] = [];
    const exporter: SpanExporter = {
      async export() {
        throw new Error('collector down');
      },
    };
    const emitter = createSpanEmitter({
      db: h.db,
      exporter,
      errorLogger: (msg, err) => logged.push({ msg, err }),
    });
    const ctx = emitter.start({ kind: 'tool_call', name: 'tool:x', runId: 'run-1' });
    emitter.end(ctx, 'ok');
    await emitter.flush();
    expect(logged.length).toBeGreaterThan(0);
  });
});

describe('createObservabilityFromConfig', () => {
  let h: Harness;
  beforeEach(async () => (h = await makeHarness()));
  afterEach(async () => tearDown(h));

  it('returns an emitter when traces are enabled', () => {
    const config = AgentOsConfigSchema.parse({
      observability: { traces: true, otlp_exporter: { enabled: false } },
    });
    const obs = createObservabilityFromConfig(config, h.db);
    expect(obs.emitter).toBeDefined();
    expect(obs.exporter).toBeUndefined();
  });

  it('returns no emitter when traces are disabled', () => {
    const config = AgentOsConfigSchema.parse({
      observability: { traces: false, otlp_exporter: { enabled: false } },
    });
    const obs = createObservabilityFromConfig(config, h.db);
    expect(obs.emitter).toBeUndefined();
  });

  it('wires the OTLP exporter when enabled with a non-empty endpoint', async () => {
    const calls: string[] = [];
    const fakeFetch: typeof fetch = async (url) => {
      calls.push(String(url));
      return new Response(null, { status: 200 });
    };
    const config = AgentOsConfigSchema.parse({
      observability: {
        traces: true,
        otlp_exporter: { enabled: true, endpoint: 'http://localhost:4318' },
      },
    });
    const obs = createObservabilityFromConfig(config, h.db, { fetchImpl: fakeFetch });
    expect(obs.emitter).toBeDefined();
    expect(obs.exporter).toBeDefined();
    const ctx = obs.emitter!.start({ kind: 'agent', name: 'a', runId: 'run-1' });
    obs.emitter!.end(ctx, 'ok');
    await obs.emitter!.flush();
    expect(calls).toEqual(['http://localhost:4318/v1/traces']);
  });

  it('does not enable the exporter when the endpoint is empty', () => {
    const config = AgentOsConfigSchema.parse({
      observability: {
        traces: true,
        otlp_exporter: { enabled: true, endpoint: '' },
      },
    });
    const obs = createObservabilityFromConfig(config, h.db);
    expect(obs.exporter).toBeUndefined();
  });
});

describe('formatNullableNumber', () => {
  it('renders null/undefined/NaN as a dash', () => {
    expect(formatNullableNumber(null)).toBe('—');
    expect(formatNullableNumber(undefined)).toBe('—');
    expect(formatNullableNumber(Number.NaN)).toBe('—');
  });

  it('preserves integers without decimals', () => {
    expect(formatNullableNumber(42)).toBe('42');
  });

  it('applies fractionDigits only to non-integer values', () => {
    expect(formatNullableNumber(0.0123, { fractionDigits: 4 })).toBe('0.0123');
    expect(formatNullableNumber(7, { fractionDigits: 4 })).toBe('7');
  });

  it('appends the unit when provided', () => {
    expect(formatNullableNumber(1.5, { fractionDigits: 2, unit: 'USD' })).toBe('1.50 USD');
  });
});

// Quiet a noisy vitest mock leak warning when the module-side fetch isn't used.
void vi;
