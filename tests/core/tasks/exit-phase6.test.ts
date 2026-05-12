/**
 * Phase 6 Exit-criterion test (PRD §3 Phase 6).
 *
 * Verbatim from the PRD:
 *   "A workflow that writes a file pauses, shows up in `approvals list`,
 *    and resumes correctly on approve."
 *
 * The single source of truth for the Phase 6 exit criterion. This test is
 * deliberately blunt: tiny workflow → run → pause → list → approve → resume
 * → check audit event. No edge cases, no policy fan-out — that's covered by
 * the queue/policies/integration suites.
 *
 * The "writes a file" step is modelled by a follow-up `agent` step whose
 * goal mentions a file write. The executor doesn't itself touch the
 * filesystem; the fake provider stands in for the model that would emit a
 * `fs.write` tool call. The Exit criterion is about the *gate*, not the
 * downstream write, and asserting "after the approval, the executor
 * proceeded to the next step that was supposed to do the write" is enough
 * to demonstrate the criterion is met.
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
import { decideRequest, listRequests } from '../../../src/core/approvals/index.js';
import { openDatabase, type AgentOsDb } from '../../../src/storage/db.js';
import { runMigrations } from '../../../src/storage/migrate.js';
import { createBlobStore, type BlobStore } from '../../../src/storage/blobs.js';
import { agents, events, runs } from '../../../src/storage/schema.js';
import { createFakeProviderAdapter } from './_fake-provider-adapter.js';

interface Harness {
  rootDir: string;
  db: AgentOsDb;
  blobs: BlobStore;
}

async function makeHarness(): Promise<Harness> {
  const rootDir = await mkdtemp(join(tmpdir(), 'agent-os-phase6-exit-'));
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
    id: 'writer',
    version: '1',
    definitionPath: 'agents/writer.md',
    hash: 'cafebabe',
    createdAt: new Date(),
  });
  return { rootDir, db, blobs };
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

describe('Phase 6 Exit criterion (PRD §3)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => tearDown(h));

  it('Phase 6 Exit — workflow pauses on approval, lists, and resumes on approve', async () => {
    // The "writes a file" workflow: gate then a writer agent step.
    const def: WorkflowDef = {
      id: 'write-after-approval',
      version: 1,
      steps: [
        { kind: 'approval', id: 'gate', prompt: 'OK to write /tmp/out.txt?', risk: 'write' },
        {
          kind: 'agent',
          id: 'do-write',
          agent: 'writer',
          goal: 'write /tmp/out.txt with the rendered report',
        },
      ],
    };
    const adapter = createFakeProviderAdapter();
    const runId = 'r-phase6-exit';

    // 1. Run the workflow with a 'pending' resolver — proves it pauses.
    const evs1 = await collectEvents(
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
    expect(evs1.some((e) => e.type === 'workflow_paused')).toBe(true);
    expect((await h.db.select().from(runs).where(eq(runs.id, runId)))[0]?.status).toBe('pending');
    // Writer step has NOT run.
    expect(adapter.callsFor('do-write')).toHaveLength(0);

    // 2. The approval shows up in `approvals list`. We use the queue API
    //    here rather than the CLI to keep this test focused on the executor
    //    boundary; the CLI test (`tests/cli/approvals-commands.test.ts`)
    //    exercises the user-facing surface in parallel.
    const listed = await listRequests({ db: h.db, runId, includeExpired: true });
    expect(listed).toHaveLength(1);
    const approvalId = listed[0]!.id;
    expect(listed[0]!.status).toBe('pending');
    expect(listed[0]!.runId).toBe(runId);

    // 3. Approve the request.
    await decideRequest({
      db: h.db,
      approvalId,
      verdict: 'approve',
      decidedBy: 'cli-user',
      note: 'go',
    });

    // 4. Resume — the workflow completes successfully.
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
    expect((await h.db.select().from(runs).where(eq(runs.id, runId)))[0]?.status).toBe('succeeded');
    // The downstream write step ran exactly once after the gate was opened.
    expect(adapter.callsFor('do-write')).toHaveLength(1);

    // 5. The audit trail contains an `approval.approved` event for this id.
    const audit = await h.db.select().from(events).where(eq(events.kind, 'approval.approved'));
    const matched = audit
      .map((r) => JSON.parse(r.payload) as { approval_id: string })
      .filter((p) => p.approval_id === approvalId);
    expect(matched).toHaveLength(1);
  });
});
