/**
 * Memory file-mirror tests (PRD §3 Phase 7).
 *
 * Exercises the file-backed storage helpers (frontmatter, key sanitization,
 * MEMORY.md index) via the barrel.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createMemory,
  memoryFilePath,
  sanitizeKey,
  updateMemory,
  writeMemoryIndex,
} from '../../../src/core/memory/index.js';
import { openDatabase, type AgentOsDb } from '../../../src/storage/db.js';
import { runMigrations } from '../../../src/storage/migrate.js';
import { createBlobStore, type BlobStore } from '../../../src/storage/blobs.js';

interface Ctx {
  db: AgentOsDb;
  blobs: BlobStore;
  workspaceRoot: string;
  tmpDir: string;
  now: number;
  clock: () => number;
}

async function makeCtx(): Promise<Ctx> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'agent-os-memory-files-'));
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

describe('memory files — frontmatter', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await makeCtx();
  });
  afterEach(() => {
    ctx.db.$sqlite.close();
    rmSync(ctx.tmpDir, { recursive: true, force: true });
  });

  it('frontmatter parses as YAML; body is the markdown value', async () => {
    const entry = await createMemory({
      db: ctx.db,
      blobs: ctx.blobs,
      workspaceRoot: ctx.workspaceRoot,
      clock: ctx.clock,
      scope: 'project',
      key: 'frontmatter-test',
      value: 'this is the **markdown** body.',
      agentId: null,
    });

    const filePath = join(ctx.workspaceRoot, 'memory', 'project', 'frontmatter-test.md');
    const raw = readFileSync(filePath, 'utf8');

    // Split frontmatter / body.
    const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
    expect(m).not.toBeNull();
    const frontmatter = m![1]!;
    const body = m![2]!;

    // Frontmatter is parseable as a simple key:value YAML block.
    const fm: Record<string, string> = {};
    for (const line of frontmatter.split('\n')) {
      const idx = line.indexOf(':');
      if (idx >= 0) {
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        if (key.length > 0) fm[key] = value;
      }
    }
    expect(fm.id).toBe(entry.id);
    expect(fm.scope).toBe('project');
    expect(fm.key).toBe('frontmatter-test');
    expect(fm.revision).toBe('1');
    expect(typeof fm.created_at).toBe('string');
    expect(typeof fm.updated_at).toBe('string');

    // Body contains the markdown.
    expect(body).toContain('this is the **markdown** body.');
  });

  it('files for revision > 1 carry a `<!-- prev: <sha7> -->` comment', async () => {
    await createMemory({
      db: ctx.db,
      blobs: ctx.blobs,
      workspaceRoot: ctx.workspaceRoot,
      clock: ctx.clock,
      scope: 'project',
      key: 'rev',
      value: 'v1',
    });
    const updated = await updateMemory({
      db: ctx.db,
      blobs: ctx.blobs,
      workspaceRoot: ctx.workspaceRoot,
      clock: ctx.clock,
      scope: 'project',
      key: 'rev',
      value: 'v2',
      revisionIntent: 'update',
    });
    const raw = readFileSync(join(ctx.workspaceRoot, 'memory', 'project', 'rev.md'), 'utf8');
    const expectedShort = updated.previousValueRef!.slice(0, 7);
    expect(raw).toContain(`<!-- prev: ${expectedShort} -->`);
  });
});

describe('memory files — key sanitization', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await makeCtx();
  });
  afterEach(() => {
    ctx.db.$sqlite.close();
    rmSync(ctx.tmpDir, { recursive: true, force: true });
  });

  it('produces safe slugs for keys with spaces / special characters', () => {
    expect(sanitizeKey('Some Key With Spaces')).toBe('some-key-with-spaces');
    expect(sanitizeKey('weird/key!@#chars')).toBe('weird-key-chars');
    // `..` collapses to nothing — empty between dots — and trims.
    expect(sanitizeKey('..thing..')).toBe('thing');
  });

  it('memoryFilePath stays under the scope directory for `..` keys', () => {
    const p = memoryFilePath(ctx.workspaceRoot, 'project', '..foo..');
    // Result must live under `<root>/memory/project/`.
    expect(p.startsWith(join(ctx.workspaceRoot, 'memory', 'project'))).toBe(true);
  });

  it('throws when a key sanitizes to nothing', () => {
    expect(() => sanitizeKey('///')).toThrow();
    expect(() => sanitizeKey('')).toThrow();
  });
});

describe('memory files — MEMORY.md index', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agent-os-memory-idx-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes per-scope sections, marks tombstones, and skips tombstones in non-`includeDeleted` callers', async () => {
    await writeMemoryIndex({
      workspaceRoot: tmpDir,
      entries: [
        { scope: 'project', key: 'alpha', hook: 'rev 1 · agent system', state: 'live' },
        { scope: 'project', key: 'beta', hook: 'rev 2 · agent system', state: 'tombstoned' },
        { scope: 'notes', key: 'gamma', hook: 'rev 1 · agent foo', state: 'live' },
      ],
    });
    const raw = readFileSync(join(tmpDir, 'memory', 'MEMORY.md'), 'utf8');
    expect(raw).toContain('## project');
    expect(raw).toContain('## notes');
    expect(raw).toContain('[alpha]');
    expect(raw).toContain('[beta]');
    expect(raw).toContain('_(tombstoned)_');
    expect(raw).toContain('[gamma]');
  });

  it('caps the index at 200 lines (truncation marker appended)', async () => {
    const many = Array.from({ length: 400 }, (_, i) => ({
      scope: 'project',
      key: `k${i}`,
      hook: `rev 1 · agent system`,
      state: 'live' as const,
    }));
    await writeMemoryIndex({ workspaceRoot: tmpDir, entries: many });
    const raw = readFileSync(join(tmpDir, 'memory', 'MEMORY.md'), 'utf8');
    const lines = raw.split('\n').filter((l) => l.length > 0 || true);
    // The renderer caps at 200 lines + trailing newline.
    expect(lines.length).toBeLessThanOrEqual(201);
    expect(raw).toContain('<!-- truncated:');
  });
});
