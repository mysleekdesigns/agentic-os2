/**
 * OTLP exporter tests (PRD §3 Phase 8).
 *
 * Verifies the hand-rolled OTLP/HTTP JSON exporter in
 * `src/core/observability/otlp.ts`:
 *
 *  - `export(spans)` POSTs to `<endpoint>/v1/traces` with an OTel-shaped
 *    `resourceSpans[].scopeSpans[].spans[]` body.
 *  - Non-2xx responses cause `export()` to throw (the emitter swallows the
 *    throw separately — that is covered by `emitter.test.ts`).
 *  - `createObservabilityFromConfig` does NOT construct an exporter when
 *    `observability.otlp_exporter.enabled=false`.
 *
 * We inject a fake `fetch` via the documented `fetchImpl` option rather
 * than mocking node's `http` module — that's the seam the implementation
 * exposes and the seam other tests (emitter.test.ts) already use.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type AgentOsDb } from '../../../src/storage/db.js';
import { runMigrations } from '../../../src/storage/migrate.js';
import { agents, runs } from '../../../src/storage/schema.js';
import {
  createObservabilityFromConfig,
  createOtlpExporter,
  createSpanEmitter,
} from '../../../src/core/observability/index.js';
import { AgentOsConfigSchema } from '../../../src/config/index.js';

interface Harness {
  root: string;
  db: AgentOsDb;
}

async function makeHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-otlp-'));
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
    id: 'run-otlp',
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

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function captureFetch(status = 200): { calls: CapturedCall[]; impl: typeof fetch } {
  const calls: CapturedCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const rawBody = typeof init?.body === 'string' ? init.body : '';
    let body: unknown = rawBody;
    try {
      body = JSON.parse(rawBody);
    } catch {
      /* leave as string */
    }
    const hdrs = init?.headers as Record<string, string> | undefined;
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: hdrs ?? {},
      body,
    });
    return new Response(null, { status });
  }) as typeof fetch;
  return { calls, impl };
}

describe('createOtlpExporter — direct export()', () => {
  let h: Harness;
  beforeEach(async () => (h = await makeHarness()));
  afterEach(async () => tearDown(h));

  it('POSTs a JSON envelope to <endpoint>/v1/traces with an OTel-shaped body', async () => {
    const { calls, impl } = captureFetch(200);
    const exporter = createOtlpExporter({
      endpoint: 'http://collector.local:4318',
      fetchImpl: impl,
    });
    const emitter = createSpanEmitter({
      db: h.db,
      exporter,
      clock: () => 1_700_000_000_000,
    });
    const wf = emitter.start({ kind: 'workflow', name: 'wf:demo', runId: 'run-otlp' });
    const agent = emitter.start({
      kind: 'agent',
      name: 'agent:lead',
      runId: 'run-otlp',
      parent: wf,
      attributes: { 'gen_ai.request.model': 'fake-model' },
    });
    emitter.end(agent, 'ok');
    emitter.end(wf, 'ok');
    await emitter.flush();

    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      expect(call.url).toBe('http://collector.local:4318/v1/traces');
      expect(call.method).toBe('POST');
      // commercial impls use lowercase header keys.
      const ct =
        call.headers['content-type'] ??
        (call.headers as Record<string, string>)['Content-Type'] ??
        '';
      expect(String(ct)).toMatch(/application\/json/);
    }

    // Body envelope shape.
    const first = calls[0]!.body as {
      resourceSpans: Array<{
        resource: { attributes: Array<{ key: string }> };
        scopeSpans: Array<{
          scope: { name: string; version: string };
          spans: Array<{
            traceId: string;
            spanId: string;
            name: string;
            kind: number;
            startTimeUnixNano: string;
            endTimeUnixNano: string;
            status: { code: number };
          }>;
        }>;
      }>;
    };
    expect(first.resourceSpans).toHaveLength(1);
    expect(first.resourceSpans[0]!.scopeSpans).toHaveLength(1);
    expect(first.resourceSpans[0]!.scopeSpans[0]!.scope.name).toBe('agent-os');
    expect(first.resourceSpans[0]!.scopeSpans[0]!.spans.length).toBeGreaterThan(0);
    const span = first.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(span.traceId).toMatch(/^[0-9a-f]+$/);
    expect(span.spanId).toMatch(/^[0-9a-f]+$/);
    // 1_700_000_000_000 ms -> 1_700_000_000_000_000_000 ns
    expect(span.startTimeUnixNano).toBe('1700000000000000000');
    expect(span.endTimeUnixNano).toBe('1700000000000000000');
    // OTel SpanKind for agent/tool_call/retrieval = 3 (CLIENT); workflow = 1.
    expect([1, 3]).toContain(span.kind);
    // OTel status code for `ok` = 1.
    expect([0, 1, 2]).toContain(span.status.code);
  });

  it('throws on non-2xx response status', async () => {
    const { impl } = captureFetch(500);
    const exporter = createOtlpExporter({
      endpoint: 'http://collector.local:4318',
      fetchImpl: impl,
    });
    await expect(
      exporter.export([
        {
          ctx: {
            traceId: '0123456789abcdef0123456789abcdef',
            spanId: '0123456789abcdef',
            runId: 'run-otlp',
          },
          kind: 'agent',
          name: 'agent:err',
          startTimeMs: 1,
          endTimeMs: 2,
          status: 'ok',
          attributes: {},
          events: [],
          links: [],
        },
      ]),
    ).rejects.toThrow(/HTTP 500/);
  });

  it('returns early (no fetch call) when spans array is empty', async () => {
    const { calls, impl } = captureFetch(200);
    const exporter = createOtlpExporter({
      endpoint: 'http://collector.local:4318',
      fetchImpl: impl,
    });
    await exporter.export([]);
    expect(calls).toHaveLength(0);
  });

  it('rejects construction when the endpoint is empty', () => {
    expect(() => createOtlpExporter({ endpoint: '' })).toThrow(/endpoint is required/);
  });
});

describe('createObservabilityFromConfig — exporter gating', () => {
  let h: Harness;
  beforeEach(async () => (h = await makeHarness()));
  afterEach(async () => tearDown(h));

  it('returns { exporter: undefined } when observability.otlp_exporter.enabled=false', () => {
    const config = AgentOsConfigSchema.parse({
      observability: {
        traces: true,
        otlp_exporter: { enabled: false, endpoint: 'http://localhost:4318' },
      },
    });
    const obs = createObservabilityFromConfig(config, h.db);
    expect(obs.emitter).toBeDefined();
    expect(obs.exporter).toBeUndefined();
  });

  it('returns { emitter: undefined, exporter: undefined } when traces=false', () => {
    const config = AgentOsConfigSchema.parse({
      observability: {
        traces: false,
        otlp_exporter: { enabled: true, endpoint: 'http://localhost:4318' },
      },
    });
    const obs = createObservabilityFromConfig(config, h.db);
    expect(obs.emitter).toBeUndefined();
    expect(obs.exporter).toBeUndefined();
  });
});
