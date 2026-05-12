/**
 * Memory search tests (PRD §3 Phase 7).
 *
 * Covers the lexical fallback (always available) and the semantic path
 * (conditional on sqlite-vec being loadable in this environment).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createMemory, removeMemory, searchMemory } from '../../../src/core/memory/index.js';
import { openDatabase, type AgentOsDb } from '../../../src/storage/db.js';
import { runMigrations } from '../../../src/storage/migrate.js';
import { createBlobStore, type BlobStore } from '../../../src/storage/blobs.js';
import { tryLoadVec } from '../../../src/storage/vec.js';

interface Ctx {
  db: AgentOsDb;
  blobs: BlobStore;
  workspaceRoot: string;
  tmpDir: string;
  now: number;
  clock: () => number;
}

async function makeCtx(): Promise<Ctx> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'agent-os-memory-search-'));
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

describe('searchMemory — lexical fallback', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await makeCtx();
    await createMemory({
      db: ctx.db,
      blobs: ctx.blobs,
      workspaceRoot: ctx.workspaceRoot,
      clock: ctx.clock,
      scope: 'project',
      key: 'rocket',
      value: 'rockets fly high through clouds and stars',
    });
    await createMemory({
      db: ctx.db,
      blobs: ctx.blobs,
      workspaceRoot: ctx.workspaceRoot,
      clock: ctx.clock,
      scope: 'project',
      key: 'submarine',
      value: 'a submarine dives deep beneath the waves',
    });
    await createMemory({
      db: ctx.db,
      blobs: ctx.blobs,
      workspaceRoot: ctx.workspaceRoot,
      clock: ctx.clock,
      scope: 'notes',
      key: 'fish',
      value: 'fish swim in schools through warm tropical waters',
    });
    await createMemory({
      db: ctx.db,
      blobs: ctx.blobs,
      workspaceRoot: ctx.workspaceRoot,
      clock: ctx.clock,
      scope: 'unrelated',
      key: 'misc',
      value: 'nothing relevant here',
    });
  });
  afterEach(() => {
    ctx.db.$sqlite.close();
    rmSync(ctx.tmpDir, { recursive: true, force: true });
  });

  it('ranks by token overlap with the query', async () => {
    const results = await searchMemory({
      db: ctx.db,
      blobs: ctx.blobs,
      query: 'rockets stars',
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.entry.key).toBe('rocket');
    expect(results[0]!.score).toBeGreaterThan(0);
  });

  it('filters tombstoned rows', async () => {
    await removeMemory({
      db: ctx.db,
      blobs: ctx.blobs,
      workspaceRoot: ctx.workspaceRoot,
      clock: ctx.clock,
      scope: 'project',
      key: 'rocket',
    });
    const results = await searchMemory({
      db: ctx.db,
      blobs: ctx.blobs,
      query: 'rockets',
    });
    expect(results.find((r) => r.entry.key === 'rocket')).toBeUndefined();
  });

  it('supports multi-scope filter via array', async () => {
    const results = await searchMemory({
      db: ctx.db,
      blobs: ctx.blobs,
      query: 'fish submarine rockets',
      scope: ['project', 'notes'],
    });
    const scopes = results.map((r) => r.entry.scope);
    expect(scopes).not.toContain('unrelated');
    expect(scopes.every((s) => s === 'project' || s === 'notes')).toBe(true);
  });

  it('honours topK', async () => {
    const results = await searchMemory({
      db: ctx.db,
      blobs: ctx.blobs,
      query: 'fish submarine rockets',
      topK: 1,
    });
    expect(results.length).toBeLessThanOrEqual(1);
  });
});

describe('searchMemory — semantic mode (conditional on sqlite-vec)', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await makeCtx();
  });
  afterEach(() => {
    ctx.db.$sqlite.close();
    rmSync(ctx.tmpDir, { recursive: true, force: true });
  });

  it('semantic ordering wins when vectors are available, else falls back lexically', async () => {
    const vec = await tryLoadVec(ctx.db);

    // The vec0 virtual table (migration 0002) is dimensioned at float[1536].
    // We construct sparse 1536-d basis vectors so the test works against the
    // real on-disk schema; when vec is unavailable the engine falls back to
    // lexical and the vector dimensions are irrelevant.
    const dim = 1536;
    const alphaVec = new Array(dim).fill(0);
    alphaVec[0] = 1; // basis 0
    const betaVec = new Array(dim).fill(0);
    betaVec[1] = 1; // basis 1

    // We craft a query whose embedding is identical to beta but whose lexical
    // tokens overlap better with alpha — so ordering differs between modes.
    await createMemory({
      db: ctx.db,
      blobs: ctx.blobs,
      workspaceRoot: ctx.workspaceRoot,
      clock: ctx.clock,
      scope: 'project',
      key: 'alpha',
      value: 'rocket rocket rocket the keyword is rocket',
      embedding: alphaVec,
    });
    await createMemory({
      db: ctx.db,
      blobs: ctx.blobs,
      workspaceRoot: ctx.workspaceRoot,
      clock: ctx.clock,
      scope: 'project',
      key: 'beta',
      value: 'totally unrelated body text about submarines',
      embedding: betaVec,
    });

    // Query embedding is closest to beta.
    const semantic = await searchMemory({
      db: ctx.db,
      blobs: ctx.blobs,
      query: 'rocket',
      embedding: betaVec,
    });

    if (!vec.available) {
      // Without sqlite-vec the engine falls back to lexical, where "rocket"
      // tokens overlap with alpha's body.
      expect(semantic.length).toBeGreaterThan(0);
      expect(semantic[0]!.entry.key).toBe('alpha');
      return;
    }

    // With sqlite-vec, semantic similarity should pull beta to the top despite
    // lexical disadvantage.
    expect(semantic.length).toBeGreaterThan(0);
    expect(semantic[0]!.entry.key).toBe('beta');
  });
});
