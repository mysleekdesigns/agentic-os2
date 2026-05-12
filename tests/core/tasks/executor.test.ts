/**
 * Durable executor tests (PRD §3 Phase 5).
 *
 * The headline test ("Restart-safe (Phase 5 Exit)") directly demonstrates the
 * Phase 5 exit criterion: kill the process mid-workflow, re-open the DB on a
 * fresh connection, and `resumeWorkflow` picks up from the last completed step
 * without re-executing earlier ones.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import {
  cancelWorkflow,
  resumeWorkflow,
  runWorkflow,
  type WorkflowDef,
  type WorkflowEvent,
} from '../../../src/core/tasks/index.js';
import { openDatabase, type AgentOsDb } from '../../../src/storage/db.js';
import { runMigrations } from '../../../src/storage/migrate.js';
import { createBlobStore, type BlobStore } from '../../../src/storage/blobs.js';
import { agents, approvals, events, runs, steps } from '../../../src/storage/schema.js';
import { createFakeProviderAdapter, type FakeProviderAdapter } from './_fake-provider-adapter.js';

// ---------------------------------------------------------------------------
// Shared test harness
// ---------------------------------------------------------------------------

interface Harness {
  rootDir: string;
  dbPath: string;
  db: AgentOsDb;
  blobs: BlobStore;
}

async function makeHarness(): Promise<Harness> {
  const rootDir = await mkdtemp(join(tmpdir(), 'agent-os-exec-'));
  const dbPath = join(rootDir, 'agent-os.sqlite');
  const db = openDatabase(dbPath);
  await runMigrations(db, { log: () => undefined });
  const blobs = createBlobStore({ root: join(rootDir, 'blobs') });
  // Seed the lead agent referenced by every workflow run.
  await db.insert(agents).values({
    id: 'lead',
    version: '1',
    definitionPath: 'agents/lead.md',
    hash: 'cafebabe',
    createdAt: new Date(),
  });
  // Seed any worker/subagent ids used in the tests so FK constraints pass.
  for (const id of ['worker_a', 'worker_b', 'planner', 'doer', 'fail_then_ok']) {
    await db.insert(agents).values({
      id,
      version: '1',
      definitionPath: `agents/${id}.md`,
      hash: 'cafebabe',
      createdAt: new Date(),
    });
  }
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

const stepRow = async (
  h: Harness,
  runId: string,
  stepId: string,
): Promise<{ id: string; status: string; kind: string; name: string } | undefined> => {
  const rows = await h.db
    .select()
    .from(steps)
    .where(eq(steps.id, `${runId}:${stepId}`));
  return rows[0]
    ? { id: rows[0].id, status: rows[0].status, kind: rows[0].kind, name: rows[0].name }
    : undefined;
};

const runRow = async (h: Harness, runId: string) => {
  const rows = await h.db.select().from(runs).where(eq(runs.id, runId));
  return rows[0];
};

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

describe('runWorkflow — sequential success', () => {
  let h: Harness;
  beforeEach(async () => (h = await makeHarness()));
  afterEach(async () => tearDown(h));

  it('runs three agent steps in order and persists each one', async () => {
    const def: WorkflowDef = {
      id: 'three-step',
      version: 1,
      steps: [
        { kind: 'agent', id: 's1', agent: 'worker_a', goal: 'first' },
        { kind: 'agent', id: 's2', agent: 'worker_a', goal: 'second' },
        { kind: 'agent', id: 's3', agent: 'worker_a', goal: 'third' },
      ],
    };
    const adapter: FakeProviderAdapter = createFakeProviderAdapter();
    const runId = 'r-seq';

    const events = await collectEvents(
      runWorkflow({
        def,
        runId,
        agentId: 'lead',
        db: h.db,
        blobs: h.blobs,
        providerAdapter: adapter,
      }),
    );

    const types = events.map((e) => e.type);
    expect(types).toContain('workflow_completed');
    expect(adapter.callCount()).toBe(3);

    // Strict ordering of completed events:
    const completedIds = events
      .filter((e) => e.type === 'step_completed' && e.kind === 'agent')
      .map((e) => (e as { stepId: string }).stepId);
    expect(completedIds).toEqual(['s1', 's2', 's3']);

    for (const id of ['s1', 's2', 's3']) {
      const row = await stepRow(h, runId, id);
      expect(row?.status).toBe('succeeded');
    }
    expect((await runRow(h, runId))?.status).toBe('succeeded');
  });
});

describe('runWorkflow — parallel fan-out', () => {
  let h: Harness;
  beforeEach(async () => (h = await makeHarness()));
  afterEach(async () => tearDown(h));

  it('runs both branches and marks the parent succeeded only after they join', async () => {
    const def: WorkflowDef = {
      id: 'par',
      version: 1,
      steps: [
        {
          kind: 'parallel',
          id: 'fan',
          branches: [
            [{ kind: 'agent', id: 'left', agent: 'worker_a', goal: 'left' }],
            [{ kind: 'agent', id: 'right', agent: 'worker_b', goal: 'right' }],
          ],
        },
      ],
    };
    const adapter = createFakeProviderAdapter();
    const runId = 'r-par';

    await collectEvents(
      runWorkflow({
        def,
        runId,
        agentId: 'lead',
        db: h.db,
        blobs: h.blobs,
        providerAdapter: adapter,
      }),
    );

    expect((await stepRow(h, runId, 'left'))?.status).toBe('succeeded');
    expect((await stepRow(h, runId, 'right'))?.status).toBe('succeeded');
    expect((await stepRow(h, runId, 'fan'))?.status).toBe('succeeded');
    expect((await runRow(h, runId))?.status).toBe('succeeded');
  });

  it('marks the parent failed when a branch fails with no retry', async () => {
    const def: WorkflowDef = {
      id: 'par-fail',
      version: 1,
      steps: [
        {
          kind: 'parallel',
          id: 'fan',
          branches: [
            [{ kind: 'agent', id: 'left', agent: 'worker_a', goal: 'l' }],
            [{ kind: 'agent', id: 'boom', agent: 'worker_b', goal: 'r' }],
          ],
        },
      ],
    };
    const adapter = createFakeProviderAdapter({
      scripts: { boom: { outcomes: [{ kind: 'throw', error: 'kaboom' }] } },
    });
    const runId = 'r-par-fail';

    await collectEvents(
      runWorkflow({
        def,
        runId,
        agentId: 'lead',
        db: h.db,
        blobs: h.blobs,
        providerAdapter: adapter,
      }),
    );

    expect((await stepRow(h, runId, 'boom'))?.status).toBe('failed');
    expect((await stepRow(h, runId, 'fan'))?.status).toBe('failed');
    expect((await runRow(h, runId))?.status).toBe('failed');
  });
});

describe('runWorkflow — conditional', () => {
  let h: Harness;
  beforeEach(async () => (h = await makeHarness()));
  afterEach(async () => tearDown(h));

  const condDef = (): WorkflowDef => ({
    id: 'cond',
    version: 1,
    steps: [
      { kind: 'agent', id: 'a', agent: 'worker_a', goal: 'check' },
      {
        kind: 'conditional',
        id: 'route',
        when: "outputs['a'].verdict === 'ok'",
        then: [{ kind: 'agent', id: 'yes', agent: 'worker_a', goal: 'yes' }],
        else: [{ kind: 'agent', id: 'no', agent: 'worker_b', goal: 'no' }],
      },
    ],
  });

  it('takes the then-branch when the predicate is true', async () => {
    const adapter = createFakeProviderAdapter({
      scripts: { a: { outcomes: [{ kind: 'ok', output: { verdict: 'ok' } }] } },
    });
    const runId = 'r-cond-then';

    await collectEvents(
      runWorkflow({
        def: condDef(),
        runId,
        agentId: 'lead',
        db: h.db,
        blobs: h.blobs,
        providerAdapter: adapter,
      }),
    );

    expect((await stepRow(h, runId, 'yes'))?.status).toBe('succeeded');
    expect(await stepRow(h, runId, 'no')).toBeUndefined();
    expect(adapter.callsFor('yes')).toHaveLength(1);
    expect(adapter.callsFor('no')).toHaveLength(0);
  });

  it('takes the else-branch when the predicate is false', async () => {
    const adapter = createFakeProviderAdapter({
      scripts: { a: { outcomes: [{ kind: 'ok', output: { verdict: 'nope' } }] } },
    });
    const runId = 'r-cond-else';

    await collectEvents(
      runWorkflow({
        def: condDef(),
        runId,
        agentId: 'lead',
        db: h.db,
        blobs: h.blobs,
        providerAdapter: adapter,
      }),
    );

    expect((await stepRow(h, runId, 'no'))?.status).toBe('succeeded');
    expect(await stepRow(h, runId, 'yes')).toBeUndefined();
  });
});

describe('runWorkflow — approval gate', () => {
  let h: Harness;
  beforeEach(async () => (h = await makeHarness()));
  afterEach(async () => tearDown(h));

  it('emits approval_requested, persists pending row, pauses the run, then resumes on approval', async () => {
    const def: WorkflowDef = {
      id: 'wf-approval',
      version: 1,
      steps: [
        { kind: 'agent', id: 'pre', agent: 'worker_a', goal: 'pre' },
        { kind: 'approval', id: 'gate', prompt: 'ship it?', risk: 'write' },
        { kind: 'agent', id: 'post', agent: 'worker_a', goal: 'post' },
      ],
    };
    const adapter = createFakeProviderAdapter();
    const runId = 'r-appr';

    const events1 = await collectEvents(
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

    expect(events1.some((e) => e.type === 'approval_requested')).toBe(true);
    expect(events1.some((e) => e.type === 'workflow_paused')).toBe(true);

    const approvalRows = await h.db.select().from(approvals);
    expect(approvalRows).toHaveLength(1);
    expect(approvalRows[0]?.status).toBe('pending');
    expect((await runRow(h, runId))?.status).toBe('pending');
    // Post step has NOT run yet.
    expect(adapter.callsFor('post')).toHaveLength(0);

    // Operator flips the approval to approved out-of-band.
    await h.db
      .update(approvals)
      .set({ status: 'approved', decidedBy: 'test', decidedAt: new Date() })
      .where(eq(approvals.id, approvalRows[0]!.id));

    const events2 = await collectEvents(
      resumeWorkflow({
        def,
        runId,
        db: h.db,
        blobs: h.blobs,
        providerAdapter: adapter,
      }),
    );

    expect(events2.some((e) => e.type === 'workflow_completed')).toBe(true);
    expect((await runRow(h, runId))?.status).toBe('succeeded');
    expect((await stepRow(h, runId, 'post'))?.status).toBe('succeeded');
    // Pre step was not re-executed.
    expect(adapter.callsFor('pre')).toHaveLength(1);
  });
});

describe('runWorkflow — wait_event', () => {
  let h: Harness;
  beforeEach(async () => (h = await makeHarness()));
  afterEach(async () => tearDown(h));

  it('pauses, ignores non-matching events, then resumes on matching event', async () => {
    const def: WorkflowDef = {
      id: 'wf-wait',
      version: 1,
      steps: [
        {
          kind: 'wait_event',
          id: 'wait',
          event_kind: 'merge_completed',
          match: { branch: 'main' },
        },
        { kind: 'agent', id: 'after', agent: 'worker_a', goal: 'after' },
      ],
    };
    const adapter = createFakeProviderAdapter();
    const runId = 'r-wait';

    const events1 = await collectEvents(
      runWorkflow({
        def,
        runId,
        agentId: 'lead',
        db: h.db,
        blobs: h.blobs,
        providerAdapter: adapter,
      }),
    );
    expect(events1.some((e) => e.type === 'awaiting_event')).toBe(true);
    expect((await runRow(h, runId))?.status).toBe('pending');

    // Insert a non-matching event first.
    await h.db.insert(events).values({
      id: 'e-noise',
      kind: 'merge_completed',
      payload: JSON.stringify({ branch: 'feature' }),
      createdAt: new Date(),
    });

    const events2 = await collectEvents(
      resumeWorkflow({
        def,
        runId,
        db: h.db,
        blobs: h.blobs,
        providerAdapter: adapter,
      }),
    );
    expect(events2.some((e) => e.type === 'awaiting_event')).toBe(true);
    expect(events2.some((e) => e.type === 'workflow_completed')).toBe(false);
    expect(adapter.callsFor('after')).toHaveLength(0);

    // Now insert a matching event and resume again.
    await h.db.insert(events).values({
      id: 'e-match',
      kind: 'merge_completed',
      payload: JSON.stringify({ branch: 'main' }),
      createdAt: new Date(),
    });

    const events3 = await collectEvents(
      resumeWorkflow({
        def,
        runId,
        db: h.db,
        blobs: h.blobs,
        providerAdapter: adapter,
      }),
    );
    expect(events3.some((e) => e.type === 'workflow_completed')).toBe(true);
    expect(adapter.callsFor('after')).toHaveLength(1);
  });
});

describe('runWorkflow — retry with backoff', () => {
  let h: Harness;
  beforeEach(async () => (h = await makeHarness()));
  afterEach(async () => tearDown(h));

  it('retries up to max_attempts and succeeds when the adapter finally succeeds', async () => {
    const def: WorkflowDef = {
      id: 'wf-retry',
      version: 1,
      steps: [
        {
          kind: 'agent',
          id: 'flaky',
          agent: 'fail_then_ok',
          goal: 'try',
          retry: { max_attempts: 3, backoff_ms: 10, multiplier: 2 },
        },
      ],
    };
    const adapter = createFakeProviderAdapter({
      scripts: {
        flaky: {
          outcomes: [
            { kind: 'throw', error: 'first' },
            { kind: 'throw', error: 'second' },
            { kind: 'ok', output: 'third-time-lucky' },
          ],
        },
      },
    });
    const runId = 'r-retry';

    const events = await collectEvents(
      runWorkflow({
        def,
        runId,
        agentId: 'lead',
        db: h.db,
        blobs: h.blobs,
        providerAdapter: adapter,
      }),
    );

    expect(events.some((e) => e.type === 'workflow_completed')).toBe(true);
    expect((await stepRow(h, runId, 'flaky'))?.status).toBe('succeeded');
    expect(adapter.callsFor('flaky')).toHaveLength(3);

    // Inspect retry events to confirm the configured backoff sequence.
    const retries = events.filter((e) => e.type === 'step_retrying') as Array<{
      type: 'step_retrying';
      nextDelayMs: number;
      attempt: number;
    }>;
    expect(retries).toHaveLength(2);
    expect(retries[0]?.nextDelayMs).toBe(10); // backoff_ms * multiplier^0
    expect(retries[1]?.nextDelayMs).toBe(20); // backoff_ms * multiplier^1
  });
});

describe('runWorkflow — timeout', () => {
  let h: Harness;
  beforeEach(async () => (h = await makeHarness()));
  afterEach(async () => tearDown(h));

  it('aborts a step that exceeds its timeout_ms and marks it failed', async () => {
    const def: WorkflowDef = {
      id: 'wf-timeout',
      version: 1,
      steps: [{ kind: 'agent', id: 'slow', agent: 'worker_a', goal: 'sleep', timeout_ms: 25 }],
    };
    const adapter = createFakeProviderAdapter({
      scripts: { slow: { outcomes: [{ kind: 'hang' }] } },
    });
    const runId = 'r-timeout';

    const events = await collectEvents(
      runWorkflow({
        def,
        runId,
        agentId: 'lead',
        db: h.db,
        blobs: h.blobs,
        providerAdapter: adapter,
      }),
    );

    expect(events.some((e) => e.type === 'workflow_failed' || e.type === 'step_failed')).toBe(true);
    expect((await stepRow(h, runId, 'slow'))?.status).toBe('failed');
    expect((await runRow(h, runId))?.status).toBe('failed');
  }, 5000);
});

describe('runWorkflow — idempotency by step id', () => {
  let h: Harness;
  beforeEach(async () => (h = await makeHarness()));
  afterEach(async () => tearDown(h));

  it('re-invoking with the same runId after success does not re-execute any step', async () => {
    const def: WorkflowDef = {
      id: 'wf-idem',
      version: 1,
      steps: [
        { kind: 'agent', id: 'a', agent: 'worker_a', goal: 'a' },
        { kind: 'agent', id: 'b', agent: 'worker_a', goal: 'b' },
      ],
    };
    const adapter = createFakeProviderAdapter();
    const runId = 'r-idem';

    await collectEvents(
      runWorkflow({
        def,
        runId,
        agentId: 'lead',
        db: h.db,
        blobs: h.blobs,
        providerAdapter: adapter,
      }),
    );
    expect(adapter.callCount()).toBe(2);

    adapter.reset();
    await collectEvents(
      runWorkflow({
        def,
        runId,
        agentId: 'lead',
        db: h.db,
        blobs: h.blobs,
        providerAdapter: adapter,
      }),
    );
    // No further adapter calls should have happened — the run is already
    // terminal and the executor short-circuits on the terminal row.
    expect(adapter.callCount()).toBe(0);
  });
});

describe('runWorkflow — restart-safe (Phase 5 Exit criterion)', () => {
  let h: Harness;
  beforeEach(async () => (h = await makeHarness()));
  afterEach(async () => tearDown(h));

  /**
   * Simulate a hard process kill mid-workflow:
   *
   *   1. Start a 4-step workflow.
   *   2. While step 3 is in flight, slam the SQLite connection closed —
   *      this models `kill -9` better than a cooperative AbortSignal, because
   *      it leaves the `runs.status` column at whatever was last persisted
   *      (`'running'`) and does NOT give the executor a chance to mark the
   *      run cancelled/failed.
   *   3. Re-open a fresh `Database` against the same file (proves the DB,
   *      not in-process state, is the source of truth).
   *   4. Call `resumeWorkflow` — steps 1 & 2 must NOT be re-executed,
   *      steps 3 & 4 must run, final status `succeeded`.
   *
   * This is the concrete proof of the PRD's Phase 5 exit criterion:
   *   "Killing the process mid-workflow then re-running `workflow resume`
   *    continues from the last completed step."
   */
  it('resumes from the last completed step after a simulated kill', async () => {
    const def: WorkflowDef = {
      id: 'wf-restart',
      version: 1,
      steps: [
        { kind: 'agent', id: 's1', agent: 'worker_a', goal: 'one' },
        { kind: 'agent', id: 's2', agent: 'worker_a', goal: 'two' },
        { kind: 'agent', id: 's3', agent: 'worker_a', goal: 'three' },
        { kind: 'agent', id: 's4', agent: 'worker_a', goal: 'four' },
      ],
    };
    const runId = 'r-restart';

    // Custom adapter that, on the s3 invocation, drops the DB to simulate a
    // hard kill mid-flight — the executor never gets a chance to mark the run
    // failed/cancelled because every subsequent DB write throws.
    const calls: Record<string, number> = {};
    const killOnStep3: import('../../../src/core/tasks/index.js').ProviderAdapter = {
      async runAgent(input) {
        calls[input.stepId] = (calls[input.stepId] ?? 0) + 1;
        if (input.stepId === 's3') {
          // Simulate `kill -9`: nuke the DB connection BEFORE returning.
          h.db.$sqlite.close();
          throw new Error('process killed');
        }
        return { stepId: input.stepId };
      },
    };

    // Phase 1: run until s3 triggers the simulated crash. The executor will
    // bubble the error since it can't write to the closed DB.
    try {
      await collectEvents(
        runWorkflow({
          def,
          runId,
          agentId: 'lead',
          db: h.db,
          blobs: h.blobs,
          providerAdapter: killOnStep3,
        }),
      );
    } catch {
      // Expected — DB operations after the kill throw.
    }

    // s1 and s2 completed pre-kill.
    expect(calls.s1).toBe(1);
    expect(calls.s2).toBe(1);
    expect(calls.s3).toBe(1);
    expect(calls.s4 ?? 0).toBe(0);

    // Phase 2: re-open the SAME db file with a fresh connection.
    const db2 = openDatabase(h.dbPath);
    const blobs2 = createBlobStore({ root: join(h.rootDir, 'blobs') });
    const adapter2 = createFakeProviderAdapter();

    try {
      // Sanity: pre-resume rows show s1+s2 succeeded; s3 is left running
      // (because the kill happened during it).
      const persistedSteps = await db2.select().from(steps).where(eq(steps.runId, runId));
      const byId = new Map(persistedSteps.map((r) => [r.id, r.status]));
      expect(byId.get(`${runId}:s1`)).toBe('succeeded');
      expect(byId.get(`${runId}:s2`)).toBe('succeeded');
      // s3 row may be 'running' (the kill happened after its row was inserted
      // but before its terminal update); s4 has no row yet.
      const s3Status = byId.get(`${runId}:s3`);
      if (s3Status !== undefined) expect(s3Status).not.toBe('succeeded');
      expect(byId.has(`${runId}:s4`)).toBe(false);
      // Crucially, runs.status is still 'running' — the executor never had a
      // chance to write a terminal status.
      const preResumeRun = await db2.select().from(runs).where(eq(runs.id, runId));
      expect(preResumeRun[0]?.status).toBe('running');

      const events2 = await collectEvents(
        resumeWorkflow({
          def,
          runId,
          db: db2,
          blobs: blobs2,
          providerAdapter: adapter2,
        }),
      );

      // Resumed events must include workflow_completed.
      expect(events2.some((e) => e.type === 'workflow_completed')).toBe(true);

      // Phase 5 Exit: s1 and s2 were NOT re-executed on the second adapter.
      expect(adapter2.callsFor('s1')).toHaveLength(0);
      expect(adapter2.callsFor('s2')).toHaveLength(0);
      // s3 and s4 were executed.
      expect(adapter2.callsFor('s3')).toHaveLength(1);
      expect(adapter2.callsFor('s4')).toHaveLength(1);

      // Final status:
      const finalRun = await db2.select().from(runs).where(eq(runs.id, runId));
      expect(finalRun[0]?.status).toBe('succeeded');
      const finalStep = (id: string) =>
        db2
          .select()
          .from(steps)
          .where(eq(steps.id, `${runId}:${id}`))
          .then((rs) => rs[0]?.status);
      for (const id of ['s1', 's2', 's3', 's4']) {
        expect(await finalStep(id)).toBe('succeeded');
      }
    } finally {
      db2.$sqlite.close();
      // h.db was closed by the simulated kill; replace with a no-op so the
      // afterEach hook doesn't double-close.
      h.db = { $sqlite: { close: () => undefined } } as unknown as AgentOsDb;
    }
  });
});

describe('cancelWorkflow', () => {
  let h: Harness;
  beforeEach(async () => (h = await makeHarness()));
  afterEach(async () => tearDown(h));

  it('flips a paused run to cancelled', async () => {
    const def: WorkflowDef = {
      id: 'wf-cancel',
      version: 1,
      steps: [
        { kind: 'approval', id: 'gate', prompt: 'ok?', risk: 'write' },
        { kind: 'agent', id: 'after', agent: 'worker_a', goal: 'after' },
      ],
    };
    const adapter = createFakeProviderAdapter();
    const runId = 'r-cancel';

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
    expect((await runRow(h, runId))?.status).toBe('pending');

    await cancelWorkflow({ runId, db: h.db, reason: 'user cancelled' });
    expect((await runRow(h, runId))?.status).toBe('cancelled');
  });
});
