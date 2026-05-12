/**
 * Executor ↔ approval-queue integration tests (PRD §3 Phase 6).
 *
 * These tests verify that the workflow executor speaks to the queue API
 * (`src/core/approvals/`) for every approval-step transition, NOT raw SQL
 * inserts. The "did the executor call the queue?" signal is that approval
 * rows carry a real, non-epoch `requestedAt`, AND that an `approval.requested`
 * row exists in `events`.
 *
 * Each test drives a workflow with a single `approval` step, pauses it via
 * a `'pending'` resolver, mutates the queue out-of-band, then resumes.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import {
  resumeWorkflow,
  runWorkflow,
  type WorkflowDef,
  type WorkflowEvent,
} from '../../../src/core/tasks/index.js';
import {
  decideRequest,
  expireDueRequests,
  listRequests,
} from '../../../src/core/approvals/index.js';
import { openDatabase, type AgentOsDb } from '../../../src/storage/db.js';
import { runMigrations } from '../../../src/storage/migrate.js';
import { createBlobStore, type BlobStore } from '../../../src/storage/blobs.js';
import { agents, approvals, events, runs, steps } from '../../../src/storage/schema.js';
import { createFakeProviderAdapter } from './_fake-provider-adapter.js';

interface Harness {
  rootDir: string;
  dbPath: string;
  db: AgentOsDb;
  blobs: BlobStore;
}

async function makeHarness(): Promise<Harness> {
  const rootDir = await mkdtemp(join(tmpdir(), 'agent-os-exec-appr-'));
  const dbPath = join(rootDir, 'agent-os.sqlite');
  const db = openDatabase(dbPath);
  await runMigrations(db, { log: () => undefined });
  const blobs = createBlobStore({ root: join(rootDir, 'blobs') });
  await db.insert(agents).values({
    id: 'lead',
    version: '1',
    definitionPath: 'agents/lead.md',
    hash: 'cafebabe',
    createdAt: new Date(),
  });
  await db.insert(agents).values({
    id: 'worker_a',
    version: '1',
    definitionPath: 'agents/worker_a.md',
    hash: 'cafebabe',
    createdAt: new Date(),
  });
  return { rootDir, dbPath, db, blobs };
}

async function tearDown(h: Harness): Promise<void> {
  try {
    h.db.$sqlite.close();
  } catch {
    /* already closed */
  }
  await rm(h.rootDir, { recursive: true, force: true });
}

async function collectEvents(stream: AsyncIterable<WorkflowEvent>): Promise<WorkflowEvent[]> {
  const out: WorkflowEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

function makeApprovalWorkflow(): WorkflowDef {
  return {
    id: 'wf-with-approval',
    version: 1,
    steps: [
      { kind: 'approval', id: 'gate', prompt: 'ship it?', risk: 'write' },
      { kind: 'agent', id: 'after', agent: 'worker_a', goal: 'post' },
    ],
  };
}

describe('executor + approval queue integration', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => tearDown(h));

  // -------------------------------------------------------------------------
  // pause path
  // -------------------------------------------------------------------------

  it('pauses via the queue: approval row carries a real requestedAt and an approval.requested event exists', async () => {
    const def = makeApprovalWorkflow();
    const adapter = createFakeProviderAdapter();
    const runId = 'r-pause';
    const startBoundary = Math.floor(Date.now() / 1000);

    const evs = await collectEvents(
      runWorkflow({
        def,
        runId,
        agentId: 'lead',
        db: h.db,
        blobs: h.blobs,
        providerAdapter: adapter,
        approvalResolver: async () => 'pending',
      }),
    );

    // Workflow paused (stream ends with workflow_paused).
    expect(evs.some((e) => e.type === 'workflow_paused')).toBe(true);
    expect(evs.some((e) => e.type === 'approval_requested')).toBe(true);

    // The run is parked.
    const runRow = await h.db.select().from(runs).where(eq(runs.id, runId));
    expect(runRow[0]?.status).toBe('pending');

    // The post step never ran.
    expect(adapter.callsFor('after')).toHaveLength(0);

    // The approval row exists, is pending, and carries a real requestedAt —
    // proof that the executor went through `createRequest` rather than a raw
    // insert (which would have left requestedAt at the epoch-0 default).
    const approvalRows = await h.db.select().from(approvals);
    expect(approvalRows).toHaveLength(1);
    const ap = approvalRows[0]!;
    expect(ap.status).toBe('pending');
    const requestedAtDate = ap.requestedAt as unknown as Date;
    expect(requestedAtDate).toBeInstanceOf(Date);
    expect(Math.floor(requestedAtDate.getTime() / 1000)).toBeGreaterThanOrEqual(startBoundary);

    // The audit event was appended.
    const requestedEvents = await h.db
      .select()
      .from(events)
      .where(eq(events.kind, 'approval.requested'));
    expect(requestedEvents).toHaveLength(1);
    const payload = JSON.parse(requestedEvents[0]!.payload) as { approval_id: string };
    expect(payload.approval_id).toBe(ap.id);
  });

  // -------------------------------------------------------------------------
  // resume on approve
  // -------------------------------------------------------------------------

  it('resumes successfully after decideRequest({verdict:"approve"}) and writes approval.approved', async () => {
    const def = makeApprovalWorkflow();
    const adapter = createFakeProviderAdapter();
    const runId = 'r-approve';

    await collectEvents(
      runWorkflow({
        def,
        runId,
        agentId: 'lead',
        db: h.db,
        blobs: h.blobs,
        providerAdapter: adapter,
        approvalResolver: async () => 'pending',
      }),
    );

    const ap = (await h.db.select().from(approvals))[0]!;

    // Out-of-band: a reviewer approves.
    await decideRequest({
      db: h.db,
      approvalId: ap.id,
      verdict: 'approve',
      decidedBy: 'tester',
      note: 'go',
    });

    const evs2 = await collectEvents(
      resumeWorkflow({
        def,
        runId,
        db: h.db,
        blobs: h.blobs,
        providerAdapter: adapter,
      }),
    );

    expect(evs2.some((e) => e.type === 'workflow_completed')).toBe(true);
    const finalRun = await h.db.select().from(runs).where(eq(runs.id, runId));
    expect(finalRun[0]?.status).toBe('succeeded');
    expect(adapter.callsFor('after')).toHaveLength(1);

    // Both audit kinds exist for this approval.
    const auditRows = await h.db.select().from(events);
    const kinds = auditRows
      .filter((r) => r.payload.includes(`"approval_id":"${ap.id}"`))
      .map((r) => r.kind)
      .sort();
    expect(kinds).toContain('approval.requested');
    expect(kinds).toContain('approval.approved');
  });

  // -------------------------------------------------------------------------
  // resume on reject
  // -------------------------------------------------------------------------

  it('resume after decideRequest({verdict:"reject"}) ends with runs.status=failed', async () => {
    const def = makeApprovalWorkflow();
    const adapter = createFakeProviderAdapter();
    const runId = 'r-reject';

    await collectEvents(
      runWorkflow({
        def,
        runId,
        agentId: 'lead',
        db: h.db,
        blobs: h.blobs,
        providerAdapter: adapter,
        approvalResolver: async () => 'pending',
      }),
    );
    const ap = (await h.db.select().from(approvals))[0]!;

    await decideRequest({
      db: h.db,
      approvalId: ap.id,
      verdict: 'reject',
      decidedBy: 'tester',
      note: 'nope',
    });

    await collectEvents(
      resumeWorkflow({
        def,
        runId,
        db: h.db,
        blobs: h.blobs,
        providerAdapter: adapter,
      }),
    );

    const finalRun = await h.db.select().from(runs).where(eq(runs.id, runId));
    expect(finalRun[0]?.status).toBe('failed');
    expect(adapter.callsFor('after')).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // revise → re-pause → approve
  // -------------------------------------------------------------------------

  it('revise keeps the row pending so resume re-pauses; a subsequent approve finishes the workflow', async () => {
    const def = makeApprovalWorkflow();
    const adapter = createFakeProviderAdapter();
    const runId = 'r-revise';

    await collectEvents(
      runWorkflow({
        def,
        runId,
        agentId: 'lead',
        db: h.db,
        blobs: h.blobs,
        providerAdapter: adapter,
        approvalResolver: async () => 'pending',
      }),
    );
    const ap = (await h.db.select().from(approvals))[0]!;

    // Revise. Row stays pending; action is rewritten.
    await decideRequest({
      db: h.db,
      approvalId: ap.id,
      verdict: 'revise',
      decidedBy: 'tester',
      revisedAction: 'shipped-with-extra-care',
      note: 'tweak',
    });

    const afterRevise = await h.db.select().from(approvals).where(eq(approvals.id, ap.id));
    expect(afterRevise[0]?.status).toBe('pending');
    expect(afterRevise[0]?.revisedAction).toBe('shipped-with-extra-care');

    // Resume — the row is still pending, so the executor's resolver runs
    // again. We pass a fresh 'pending' resolver to demonstrate the re-pause.
    const evs2 = await collectEvents(
      resumeWorkflow({
        def,
        runId,
        db: h.db,
        blobs: h.blobs,
        providerAdapter: adapter,
        approvalResolver: async () => 'pending',
      }),
    );
    expect(evs2.some((e) => e.type === 'workflow_paused')).toBe(true);
    const reRun = await h.db.select().from(runs).where(eq(runs.id, runId));
    expect(reRun[0]?.status).toBe('pending');

    // Now approve. Resume should finish the workflow.
    await decideRequest({
      db: h.db,
      approvalId: ap.id,
      verdict: 'approve',
      decidedBy: 'tester',
    });

    const evs3 = await collectEvents(
      resumeWorkflow({
        def,
        runId,
        db: h.db,
        blobs: h.blobs,
        providerAdapter: adapter,
      }),
    );
    expect(evs3.some((e) => e.type === 'workflow_completed')).toBe(true);
    const finalRun = await h.db.select().from(runs).where(eq(runs.id, runId));
    expect(finalRun[0]?.status).toBe('succeeded');
  });

  // -------------------------------------------------------------------------
  // expiration
  // -------------------------------------------------------------------------

  it('expired approval (via expireDueRequests) causes resume to end with runs.status=failed', async () => {
    const def = makeApprovalWorkflow();
    const adapter = createFakeProviderAdapter();
    const runId = 'r-expire';

    await collectEvents(
      runWorkflow({
        def,
        runId,
        agentId: 'lead',
        db: h.db,
        blobs: h.blobs,
        providerAdapter: adapter,
        approvalResolver: async () => 'pending',
      }),
    );

    const ap = (await h.db.select().from(approvals))[0]!;
    // The executor created the row with `requestedAt` ≈ now but did not pass
    // a TTL, so `expires_at` is null. Force it to a past instant so
    // `expireDueRequests` will transition it.
    await h.db
      .update(approvals)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(approvals.id, ap.id));

    const expired = await expireDueRequests({ db: h.db });
    expect(expired.map((r) => r.id)).toContain(ap.id);

    await collectEvents(
      resumeWorkflow({
        def,
        runId,
        db: h.db,
        blobs: h.blobs,
        providerAdapter: adapter,
      }),
    );

    const finalRun = await h.db.select().from(runs).where(eq(runs.id, runId));
    // The integration bundle treats `expired` as a terminal-failed outcome
    // (the executor's resume fast-path branches: approved → success;
    // rejected | expired → step_failed → run failed).
    expect(finalRun[0]?.status).toBe('failed');
    expect(adapter.callsFor('after')).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // No-API-key invariant
  // -------------------------------------------------------------------------

  it('all of the above works with ANTHROPIC_API_KEY / OPENAI_API_KEY unset', async () => {
    const savedAnthropic = process.env.ANTHROPIC_API_KEY;
    const savedOpenai = process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const def = makeApprovalWorkflow();
      const adapter = createFakeProviderAdapter();
      const runId = 'r-nokey';

      await collectEvents(
        runWorkflow({
          def,
          runId,
          agentId: 'lead',
          db: h.db,
          blobs: h.blobs,
          providerAdapter: adapter,
          approvalResolver: async () => 'pending',
        }),
      );

      const ap = (await h.db.select().from(approvals))[0]!;
      await decideRequest({
        db: h.db,
        approvalId: ap.id,
        verdict: 'approve',
        decidedBy: 'tester',
      });

      const listed = await listRequests({ db: h.db, includeExpired: true });
      expect(listed.find((r) => r.id === ap.id)?.status).toBe('approved');

      const evs2 = await collectEvents(
        resumeWorkflow({ def, runId, db: h.db, blobs: h.blobs, providerAdapter: adapter }),
      );
      expect(evs2.some((e) => e.type === 'workflow_completed')).toBe(true);
    } finally {
      if (savedAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = savedAnthropic;
      if (savedOpenai !== undefined) process.env.OPENAI_API_KEY = savedOpenai;
    }
  });
});

// Suppress unused-import warning for `steps`. Some tests above introspect
// `steps` rows when expanded; we keep the import here so future additions
// can use it without re-importing.
void steps;
