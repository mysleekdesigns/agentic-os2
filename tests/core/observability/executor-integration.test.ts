/**
 * End-to-end spans through the workflow executor (PRD §3 Phase 8).
 *
 * Verifies that running a tiny two-agent workflow with an emitter populates
 * the `traces` table with one `workflow` span and one `agent` span per step,
 * with a parent/child relationship preserved in the persisted JSON.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { openDatabase, type AgentOsDb } from '../../../src/storage/db.js';
import { runMigrations } from '../../../src/storage/migrate.js';
import { createBlobStore, type BlobStore } from '../../../src/storage/blobs.js';
import { agents, traces } from '../../../src/storage/schema.js';
import {
  runWorkflow,
  type WorkflowDef,
  type WorkflowEvent,
} from '../../../src/core/tasks/index.js';
import { createSpanEmitter } from '../../../src/core/observability/index.js';
import { createFakeProviderAdapter } from '../tasks/_fake-provider-adapter.js';

interface Harness {
  root: string;
  db: AgentOsDb;
  blobs: BlobStore;
}

async function makeHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-obs-exec-'));
  const db = openDatabase(join(root, 'agent-os.sqlite'));
  await runMigrations(db, { log: () => undefined });
  const blobs = createBlobStore({ root: join(root, 'blobs') });
  for (const id of ['lead', 'worker_a']) {
    await db.insert(agents).values({
      id,
      version: '1',
      definitionPath: `agents/${id}.md`,
      hash: '0',
      createdAt: new Date(),
    });
  }
  return { root, db, blobs };
}

async function tearDown(h: Harness): Promise<void> {
  try {
    h.db.$sqlite.close();
  } catch {
    /* already closed */
  }
  await rm(h.root, { recursive: true, force: true });
}

async function drain(stream: AsyncIterable<WorkflowEvent>): Promise<void> {
  for await (const _ev of stream) void _ev;
}

describe('executor emits spans when an emitter is supplied', () => {
  let h: Harness;
  beforeEach(async () => (h = await makeHarness()));
  afterEach(async () => tearDown(h));

  it('records a workflow span plus one agent span per step', async () => {
    const def: WorkflowDef = {
      id: 'two-step',
      version: 1,
      steps: [
        { kind: 'agent', id: 's1', agent: 'worker_a', goal: 'one' },
        { kind: 'agent', id: 's2', agent: 'worker_a', goal: 'two' },
      ],
    };
    const adapter = createFakeProviderAdapter();
    const emitter = createSpanEmitter({ db: h.db });
    const runId = 'run-obs-1';

    await drain(
      runWorkflow({
        def,
        runId,
        agentId: 'lead',
        provider: 'fake',
        model: 'fake-model',
        db: h.db,
        blobs: h.blobs,
        providerAdapter: adapter,
        emitter,
      }),
    );
    await emitter.flush();

    const rows = await h.db.select().from(traces).where(eq(traces.runId, runId));
    expect(rows).toHaveLength(3);

    const payloads = rows.map((r) => JSON.parse(r.otelSpanJson));
    const wf = payloads.find((p) => p.kind === 'workflow');
    const agentSpans = payloads.filter((p) => p.kind === 'agent');

    expect(wf).toBeDefined();
    expect(wf.name).toBe('workflow:two-step');
    expect(wf.status).toBe('ok');
    expect(wf.attributes['agent_os.workflow_id']).toBe('two-step');
    expect(wf.attributes['gen_ai.system']).toBe('fake');
    expect(wf.attributes['gen_ai.request.model']).toBe('fake-model');

    expect(agentSpans).toHaveLength(2);
    for (const a of agentSpans) {
      expect(a.status).toBe('ok');
      expect(a.context.parentSpanId).toBe(wf.context.spanId);
      expect(a.context.traceId).toBe(wf.context.traceId);
      expect(a.attributes['agent_os.agent_id']).toBe('worker_a');
      expect(a.attributes['gen_ai.operation.name']).toBe('chat');
    }
  });

  it('marks the workflow span as cancelled with paused_reason on pause', async () => {
    const def: WorkflowDef = {
      id: 'paused-wf',
      version: 1,
      steps: [
        {
          kind: 'approval',
          id: 'gate',
          prompt: 'Approve please',
          risk: 'write',
        },
      ],
    };
    const adapter = createFakeProviderAdapter();
    const emitter = createSpanEmitter({ db: h.db });
    const runId = 'run-obs-paused';

    await drain(
      runWorkflow({
        def,
        runId,
        agentId: 'lead',
        provider: 'fake',
        model: 'fake-model',
        db: h.db,
        blobs: h.blobs,
        providerAdapter: adapter,
        emitter,
        // Default resolver auto-rejects; override to 'pending' for the pause case.
        approvalResolver: async () => 'pending',
      }),
    );
    await emitter.flush();

    const rows = await h.db.select().from(traces).where(eq(traces.runId, runId));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const wf = rows.map((r) => JSON.parse(r.otelSpanJson)).find((p) => p.kind === 'workflow');
    expect(wf).toBeDefined();
    expect(wf.status).toBe('cancelled');
    expect(wf.attributes['agent_os.paused_reason']).toBe('approval');
  });
});
