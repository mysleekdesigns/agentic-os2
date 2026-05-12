/**
 * Memory engine tests (PRD §3 Phase 7).
 *
 * Exercises create / update / remove / list / get over a fresh tmp DB +
 * tmp blob store + tmp workspace. Imports only from the engine barrel
 * (`src/core/memory/index.js`) — internal sub-modules are out of bounds.
 */

import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import {
  createMemory,
  getMemory,
  listMemory,
  MemoryExistsError,
  MemoryNotFoundError,
  MemoryWritePolicyError,
  removeMemory,
  updateMemory,
} from '../../../src/core/memory/index.js';
import { openDatabase, type AgentOsDb } from '../../../src/storage/db.js';
import { runMigrations } from '../../../src/storage/migrate.js';
import { createBlobStore, type BlobStore } from '../../../src/storage/blobs.js';
import { events, memory } from '../../../src/storage/schema.js';

interface Ctx {
  db: AgentOsDb;
  blobs: BlobStore;
  workspaceRoot: string;
  tmpDir: string;
  now: number;
  clock: () => number;
}

async function makeCtx(): Promise<Ctx> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'agent-os-memory-engine-'));
  const db = openDatabase(':memory:');
  await runMigrations(db, { log: () => undefined });
  const blobs = createBlobStore({ root: join(tmpDir, 'blobs') });
  const ctx: Ctx = {
    db,
    blobs,
    workspaceRoot: tmpDir,
    tmpDir,
    now: 1_700_000_000,
    clock: () => ctx.now,
  };
  return ctx;
}

describe('memory engine — createMemory', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await makeCtx();
  });
  afterEach(() => {
    ctx.db.$sqlite.close();
    rmSync(ctx.tmpDir, { recursive: true, force: true });
  });

  it('writes blob, inserts row, mirrors file, emits memory.created', async () => {
    const entry = await createMemory({
      db: ctx.db,
      blobs: ctx.blobs,
      workspaceRoot: ctx.workspaceRoot,
      clock: ctx.clock,
      scope: 'project',
      key: 'hello',
      value: 'Hello, world.',
      agentId: null,
    });

    expect(entry.scope).toBe('project');
    expect(entry.key).toBe('hello');
    expect(entry.revision).toBe(1);
    expect(entry.previousValueRef).toBeNull();
    expect(entry.deletedAt).toBeNull();
    expect(entry.valueRef).toMatch(/^[a-f0-9]{64}$/);

    // Blob is present.
    expect(await ctx.blobs.has(entry.valueRef)).toBe(true);
    expect((await ctx.blobs.read(entry.valueRef)).toString('utf8')).toBe('Hello, world.');

    // Row is present.
    const rows = await ctx.db.select().from(memory).where(eq(memory.id, entry.id));
    expect(rows).toHaveLength(1);

    // File is present with frontmatter and value.
    const filePath = join(ctx.workspaceRoot, 'memory', 'project', 'hello.md');
    expect(existsSync(filePath)).toBe(true);
    const fileBody = readFileSync(filePath, 'utf8');
    expect(fileBody).toMatch(/^---\n/);
    expect(fileBody).toContain(`id: ${entry.id}`);
    expect(fileBody).toContain('scope: project');
    expect(fileBody).toContain('key: hello');
    expect(fileBody).toContain('revision: 1');
    expect(fileBody).toContain('Hello, world.');

    // Event row.
    const ev = await ctx.db.select().from(events).where(eq(events.kind, 'memory.created'));
    expect(ev).toHaveLength(1);
    const payload = JSON.parse(ev[0]!.payload) as Record<string, unknown>;
    expect(payload.memory_id).toBe(entry.id);
    expect(payload.scope).toBe('project');
    expect(payload.key).toBe('hello');
    expect(payload.revision).toBe(1);
  });

  it('throws MemoryExistsError on a second createMemory for the same (scope, key)', async () => {
    await createMemory({
      db: ctx.db,
      blobs: ctx.blobs,
      workspaceRoot: ctx.workspaceRoot,
      clock: ctx.clock,
      scope: 'project',
      key: 'dup',
      value: 'first',
    });

    await expect(
      createMemory({
        db: ctx.db,
        blobs: ctx.blobs,
        workspaceRoot: ctx.workspaceRoot,
        clock: ctx.clock,
        scope: 'project',
        key: 'dup',
        value: 'second',
      }),
    ).rejects.toBeInstanceOf(MemoryExistsError);
  });

  it('accepts arbitrary scope names (no CHECK constraint)', async () => {
    const scopes = ['notes', 'session', 'agent', 'project', 'user_preferences', 'custom_scope_42'];
    for (const scope of scopes) {
      const entry = await createMemory({
        db: ctx.db,
        blobs: ctx.blobs,
        workspaceRoot: ctx.workspaceRoot,
        clock: ctx.clock,
        scope,
        key: `k-${scope}`,
        value: `value for ${scope}`,
      });
      expect(entry.scope).toBe(scope);
    }

    // Confirm rows.
    const all = await ctx.db.select().from(memory);
    expect(all).toHaveLength(scopes.length);
  });
});

describe('memory engine — updateMemory', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await makeCtx();
    await createMemory({
      db: ctx.db,
      blobs: ctx.blobs,
      workspaceRoot: ctx.workspaceRoot,
      clock: ctx.clock,
      scope: 'project',
      key: 'note',
      value: 'rev1',
    });
  });
  afterEach(() => {
    ctx.db.$sqlite.close();
    rmSync(ctx.tmpDir, { recursive: true, force: true });
  });

  it('increments revision, sets previous_value_ref, updates file with prev comment, emits memory.updated', async () => {
    ctx.now += 60;
    const updated = await updateMemory({
      db: ctx.db,
      blobs: ctx.blobs,
      workspaceRoot: ctx.workspaceRoot,
      clock: ctx.clock,
      scope: 'project',
      key: 'note',
      value: 'rev2 — different content',
      revisionIntent: 'update',
    });

    expect(updated.revision).toBe(2);
    expect(updated.previousValueRef).not.toBeNull();
    expect(updated.previousValueRef).not.toBe(updated.valueRef);

    const filePath = join(ctx.workspaceRoot, 'memory', 'project', 'note.md');
    const body = readFileSync(filePath, 'utf8');
    expect(body).toContain('revision: 2');
    expect(body).toContain('<!-- prev:');
    expect(body).toContain('rev2 — different content');

    const ev = await ctx.db.select().from(events).where(eq(events.kind, 'memory.updated'));
    expect(ev).toHaveLength(1);
  });

  it("rejects revisionIntent='append' against an existing key", async () => {
    await expect(
      updateMemory({
        db: ctx.db,
        blobs: ctx.blobs,
        workspaceRoot: ctx.workspaceRoot,
        clock: ctx.clock,
        scope: 'project',
        key: 'note',
        value: 'whatever',
        // default revisionIntent='append'
      }),
    ).rejects.toBeInstanceOf(MemoryWritePolicyError);
  });

  it("revisionIntent='update' with identical content throws", async () => {
    await expect(
      updateMemory({
        db: ctx.db,
        blobs: ctx.blobs,
        workspaceRoot: ctx.workspaceRoot,
        clock: ctx.clock,
        scope: 'project',
        key: 'note',
        value: 'rev1', // identical to the seed
        revisionIntent: 'update',
      }),
    ).rejects.toBeInstanceOf(MemoryWritePolicyError);
  });

  it("revisionIntent='overwrite' succeeds with identical content and emits memory.overwritten", async () => {
    ctx.now += 60;
    const updated = await updateMemory({
      db: ctx.db,
      blobs: ctx.blobs,
      workspaceRoot: ctx.workspaceRoot,
      clock: ctx.clock,
      scope: 'project',
      key: 'note',
      value: 'rev1', // identical
      revisionIntent: 'overwrite',
    });
    expect(updated.revision).toBe(2);

    const overwrittenEv = await ctx.db
      .select()
      .from(events)
      .where(eq(events.kind, 'memory.overwritten'));
    expect(overwrittenEv).toHaveLength(1);

    const updatedEv = await ctx.db.select().from(events).where(eq(events.kind, 'memory.updated'));
    expect(updatedEv).toHaveLength(0);
  });

  it('updateMemory against a missing row throws MemoryNotFoundError', async () => {
    await expect(
      updateMemory({
        db: ctx.db,
        blobs: ctx.blobs,
        workspaceRoot: ctx.workspaceRoot,
        clock: ctx.clock,
        scope: 'project',
        key: 'never-existed',
        value: 'x',
        revisionIntent: 'update',
      }),
    ).rejects.toBeInstanceOf(MemoryNotFoundError);
  });
});

describe('memory engine — removeMemory / get / list', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await makeCtx();
  });
  afterEach(() => {
    ctx.db.$sqlite.close();
    rmSync(ctx.tmpDir, { recursive: true, force: true });
  });

  it('removeMemory sets deleted_at, keeps row + blob, writes tombstone file, emits memory.removed', async () => {
    const entry = await createMemory({
      db: ctx.db,
      blobs: ctx.blobs,
      workspaceRoot: ctx.workspaceRoot,
      clock: ctx.clock,
      scope: 'project',
      key: 'gone',
      value: 'goodbye',
    });

    ctx.now += 60;
    const removed = await removeMemory({
      db: ctx.db,
      blobs: ctx.blobs,
      workspaceRoot: ctx.workspaceRoot,
      clock: ctx.clock,
      scope: 'project',
      key: 'gone',
    });

    expect(removed.deletedAt).not.toBeNull();

    // Row still present.
    const rows = await ctx.db.select().from(memory).where(eq(memory.id, entry.id));
    expect(rows).toHaveLength(1);

    // Blob still present.
    expect(await ctx.blobs.has(entry.valueRef)).toBe(true);

    // File rewritten as a tombstone marker.
    const filePath = join(ctx.workspaceRoot, 'memory', 'project', 'gone.md');
    const body = readFileSync(filePath, 'utf8');
    expect(body).toMatch(/^> tombstoned at /);

    // Event row.
    const ev = await ctx.db.select().from(events).where(eq(events.kind, 'memory.removed'));
    expect(ev).toHaveLength(1);
  });

  it('getMemory returns null for tombstoned rows by default and the row with includeDeleted', async () => {
    await createMemory({
      db: ctx.db,
      blobs: ctx.blobs,
      workspaceRoot: ctx.workspaceRoot,
      clock: ctx.clock,
      scope: 'project',
      key: 'g2',
      value: 'x',
    });
    await removeMemory({
      db: ctx.db,
      blobs: ctx.blobs,
      workspaceRoot: ctx.workspaceRoot,
      clock: ctx.clock,
      scope: 'project',
      key: 'g2',
    });

    const live = await getMemory({ db: ctx.db, scope: 'project', key: 'g2' });
    expect(live).toBeNull();

    const dead = await getMemory({
      db: ctx.db,
      scope: 'project',
      key: 'g2',
      includeDeleted: true,
    });
    expect(dead).not.toBeNull();
    expect(dead!.deletedAt).not.toBeNull();
  });

  it('listMemory filters by scope and by agentId; excludes tombstones unless includeDeleted', async () => {
    await createMemory({
      db: ctx.db,
      blobs: ctx.blobs,
      workspaceRoot: ctx.workspaceRoot,
      clock: ctx.clock,
      scope: 'project',
      key: 'a',
      value: 'A',
      agentId: null,
    });
    await createMemory({
      db: ctx.db,
      blobs: ctx.blobs,
      workspaceRoot: ctx.workspaceRoot,
      clock: ctx.clock,
      scope: 'notes',
      key: 'b',
      value: 'B',
      agentId: null,
    });
    await createMemory({
      db: ctx.db,
      blobs: ctx.blobs,
      workspaceRoot: ctx.workspaceRoot,
      clock: ctx.clock,
      scope: 'project',
      key: 'c',
      value: 'C',
      agentId: null,
    });

    // Tombstone one.
    await removeMemory({
      db: ctx.db,
      blobs: ctx.blobs,
      workspaceRoot: ctx.workspaceRoot,
      clock: ctx.clock,
      scope: 'project',
      key: 'a',
    });

    const projectLive = await listMemory({ db: ctx.db, scope: 'project' });
    expect(projectLive.map((r) => r.key).sort()).toEqual(['c']);

    const projectAll = await listMemory({
      db: ctx.db,
      scope: 'project',
      includeDeleted: true,
    });
    expect(projectAll.map((r) => r.key).sort()).toEqual(['a', 'c']);

    const notesLive = await listMemory({ db: ctx.db, scope: 'notes' });
    expect(notesLive.map((r) => r.key)).toEqual(['b']);

    // agentId filter (no rows match a specific agent id).
    const byAgent = await listMemory({ db: ctx.db, agentId: 'agent-x' });
    expect(byAgent).toHaveLength(0);

    const byNullAgent = await listMemory({ db: ctx.db, agentId: null });
    expect(byNullAgent.length).toBeGreaterThan(0);
    expect(byNullAgent.every((r) => r.agentId === null)).toBe(true);
  });
});
