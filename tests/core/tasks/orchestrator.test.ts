/**
 * Orchestrator-worker topology tests (PRD §3 Phase 5 item 3).
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { spawnWorkers } from '../../../src/core/tasks/index.js';
import { openDatabase, type AgentOsDb } from '../../../src/storage/db.js';
import { runMigrations } from '../../../src/storage/migrate.js';
import { createBlobStore, type BlobStore } from '../../../src/storage/blobs.js';
import { agents, runs, steps } from '../../../src/storage/schema.js';
import { createFakeProviderAdapter } from './_fake-provider-adapter.js';

interface Harness {
  rootDir: string;
  db: AgentOsDb;
  blobs: BlobStore;
}

async function makeHarness(): Promise<Harness> {
  const rootDir = await mkdtemp(join(tmpdir(), 'agent-os-orch-'));
  const db = openDatabase(join(rootDir, 'agent-os.sqlite'));
  await runMigrations(db, { log: () => undefined });
  const blobs = createBlobStore({ root: join(rootDir, 'blobs') });
  for (const id of ['lead', 'worker_a', 'worker_b', 'worker_c']) {
    await db.insert(agents).values({
      id,
      version: '1',
      definitionPath: `agents/${id}.md`,
      hash: 'cafebabe',
      createdAt: new Date(),
    });
  }
  // Seed the lead run row that owns the subagent steps.
  await db.insert(runs).values({
    id: 'lead-run',
    agentId: 'lead',
    status: 'running',
    startedAt: new Date(),
    provider: 'workflow',
    model: 'lead',
  });
  return { rootDir, db, blobs };
}

async function teardown(h: Harness): Promise<void> {
  try {
    h.db.$sqlite.close();
  } catch {
    /* ignore */
  }
  await rm(h.rootDir, { recursive: true, force: true });
}

describe('spawnWorkers', () => {
  let h: Harness;
  beforeEach(async () => (h = await makeHarness()));
  afterEach(async () => teardown(h));

  it('runs N workers concurrently and writes a steps row + child runs row per worker', async () => {
    const adapter = createFakeProviderAdapter({
      scripts: {
        w1: { outcomes: [{ kind: 'ok', output: 'one' }] },
        w2: { outcomes: [{ kind: 'ok', output: 'two' }] },
        w3: { outcomes: [{ kind: 'ok', output: 'three' }] },
      },
    });

    const results: Array<{ workerId: string; failed: boolean }> = [];
    for await (const r of spawnWorkers({
      leadRunId: 'lead-run',
      leadAgentId: 'lead',
      workers: [
        { id: 'w1', agent: 'worker_a', goal: 'do a' },
        { id: 'w2', agent: 'worker_b', goal: 'do b' },
        { id: 'w3', agent: 'worker_c', goal: 'do c' },
      ],
      providerAdapter: adapter,
      db: h.db,
      blobs: h.blobs,
    })) {
      results.push({ workerId: r.workerId, failed: r.failed });
    }

    expect(results).toHaveLength(3);
    expect(results.every((r) => !r.failed)).toBe(true);
    expect(adapter.callCount()).toBe(3);

    // Each worker should have a `steps` row of kind `subagent` on the lead run.
    for (const wid of ['w1', 'w2', 'w3']) {
      const row = await h.db
        .select()
        .from(steps)
        .where(eq(steps.id, `lead-run:${wid}`));
      expect(row).toHaveLength(1);
      expect(row[0]?.kind).toBe('subagent');
      expect(row[0]?.status).toBe('succeeded');
    }

    // And a child run row should have parent_run_id === lead-run.
    const childRuns = await h.db.select().from(runs);
    const children = childRuns.filter((r) => r.parentRunId === 'lead-run');
    expect(children).toHaveLength(3);
    expect(children.every((c) => c.status === 'succeeded')).toBe(true);
  });

  it('cancels in-flight workers when the outer signal aborts', async () => {
    const controller = new AbortController();
    // Both workers hang until aborted.
    const adapter = createFakeProviderAdapter({
      scripts: {
        h1: { outcomes: [{ kind: 'hang' }] },
        h2: { outcomes: [{ kind: 'hang' }] },
      },
    });

    const iterable = spawnWorkers({
      leadRunId: 'lead-run',
      workers: [
        { id: 'h1', agent: 'worker_a', goal: 'hang1' },
        { id: 'h2', agent: 'worker_b', goal: 'hang2' },
      ],
      providerAdapter: adapter,
      db: h.db,
      blobs: h.blobs,
      signal: controller.signal,
    });

    // Fire the abort shortly after starting the iterator.
    setTimeout(() => controller.abort(), 25);

    const results = [];
    for await (const r of iterable) results.push(r);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.failed)).toBe(true);

    // The lead `steps` rows should be marked failed too.
    for (const wid of ['h1', 'h2']) {
      const row = await h.db
        .select()
        .from(steps)
        .where(eq(steps.id, `lead-run:${wid}`));
      expect(row[0]?.status).toBe('failed');
    }
  });
});
