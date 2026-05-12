/**
 * Memory engine (PRD §3 Phase 7).
 *
 * Pure functions over a Drizzle `AgentOsDb`, a content-addressed `BlobStore`,
 * and an optional filesystem root for the markdown mirror.
 *
 * Write policy
 * ------------
 *   - APPEND BY DEFAULT. New keys land via `createMemory`. Attempting to
 *     `createMemory` an existing (scope, key) with `revisionIntent='append'`
 *     throws `MemoryExistsError` — callers must use `updateMemory` instead.
 *
 *   - UPDATES REQUIRE A DIFF. `updateMemory` demands explicit
 *     `revisionIntent: 'update'` (or `'overwrite'`); the default `'append'`
 *     is rejected. With `'update'` the engine asserts the new bytes differ
 *     from the prior value — silent no-op updates are an error.
 *
 *   - DELETES ARE TOMBSTONED. `removeMemory` sets `deleted_at` and rewrites
 *     the file to a one-line marker; the SQLite row and the value blob are
 *     KEPT so the diff chain remains traversable for audit.
 *
 * Diff chain
 * ----------
 *   Each row carries `previous_value_ref`, the sha256 of the prior value
 *   blob. Walking back through revisions reconstructs every version. The
 *   blob store is content-addressed (PRD §2.4), so older blobs are not
 *   garbage-collected by this module.
 *
 * Admin / overwrite
 * -----------------
 *   `revisionIntent: 'overwrite'` skips the differs-from-prior check and
 *   emits `memory.overwritten`. Reserved for CLI / test paths that need to
 *   replace a memory exactly. Provider-mediated agent calls never set this.
 *
 * Event log
 * ---------
 *   Every state transition emits a row in `events`:
 *     kind ∈ { 'memory.created', 'memory.updated', 'memory.overwritten',
 *              'memory.removed' }
 *   payload: { memory_id, scope, key, agent_id, who, when, ... }
 */

import { and, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import type { BlobStore } from '../../storage/blobs.js';
import type { AgentOsDb } from '../../storage/db.js';
import { embeddings, events, memory } from '../../storage/schema.js';
import {
  readMemoryFile,
  removeMemoryFile,
  sanitizeKey,
  sanitizeScope,
  writeMemoryFile,
  writeMemoryIndex,
} from './files.js';
import type {
  MemoryEntry,
  MemorySearchResult,
  SearchMemoryInput,
  WriteMemoryInput,
} from './types.js';

export type Clock = () => number; // unix epoch seconds

const defaultClock: Clock = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class MemoryExistsError extends Error {
  constructor(scope: string, key: string) {
    super(`memory already exists: scope='${scope}' key='${key}' — use updateMemory`);
    this.name = 'MemoryExistsError';
  }
}

export class MemoryNotFoundError extends Error {
  constructor(scope: string, key: string) {
    super(`memory not found: scope='${scope}' key='${key}'`);
    this.name = 'MemoryNotFoundError';
  }
}

export class MemoryWritePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryWritePolicyError';
  }
}

// ---------------------------------------------------------------------------
// Internal mapping helpers
// ---------------------------------------------------------------------------

interface MemoryRow {
  id: string;
  scope: string;
  agentId: string | null;
  key: string;
  valueRef: string;
  embeddingId: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  deletedAt: Date | null;
  revision: number;
  previousValueRef: string | null;
}

function dateToSeconds(d: Date | null | undefined): number | null {
  if (!d) return null;
  return Math.floor(d.getTime() / 1000);
}

function secondsToDate(s: number): Date {
  return new Date(s * 1000);
}

function rowToEntry(row: MemoryRow): MemoryEntry {
  return {
    id: row.id,
    scope: row.scope,
    agentId: row.agentId,
    key: row.key,
    valueRef: row.valueRef,
    previousValueRef: row.previousValueRef,
    revision: row.revision,
    embeddingId: row.embeddingId,
    createdAt: dateToSeconds(row.createdAt) ?? 0,
    updatedAt: dateToSeconds(row.updatedAt) ?? 0,
    deletedAt: dateToSeconds(row.deletedAt),
  };
}

async function loadRow(db: AgentOsDb, scope: string, key: string): Promise<MemoryRow | null> {
  const rows = (await db
    .select()
    .from(memory)
    .where(and(eq(memory.scope, scope), eq(memory.key, key)))) as MemoryRow[];
  if (rows.length === 0) return null;
  return rows[0] ?? null;
}

async function emitEvent(
  db: AgentOsDb,
  kind: string,
  payload: Record<string, unknown>,
  at: number,
): Promise<void> {
  await db.insert(events).values({
    id: randomUUID(),
    kind,
    payload: JSON.stringify(payload),
    createdAt: secondsToDate(at),
  });
}

// ---------------------------------------------------------------------------
// Optional embedding write
// ---------------------------------------------------------------------------

async function writeEmbeddingIfPresent(
  db: AgentOsDb,
  entryId: string,
  embedding: number[] | undefined,
): Promise<string | null> {
  if (!embedding || embedding.length === 0) return null;
  const embeddingId = randomUUID();
  try {
    // The vec0 virtual table accepts a binary BLOB of float32 values. We
    // serialise the Float32Array buffer here. If sqlite-vec is unavailable the
    // fallback `embeddings` table accepts the same blob shape; only similarity
    // search is unavailable in that case (PRD §2.4 / Phase 1).
    const buf = Buffer.from(new Float32Array(embedding).buffer);
    await db.insert(embeddings).values({
      id: embeddingId,
      vector: buf,
      metadata: JSON.stringify({ memory_id: entryId }),
    });
    return embeddingId;
  } catch {
    // Best effort: a write failure here must not prevent the memory write.
    // Semantic search will simply skip this row.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Index regeneration
// ---------------------------------------------------------------------------

async function refreshIndex(db: AgentOsDb, workspaceRoot: string): Promise<void> {
  const rows = (await db.select().from(memory)) as MemoryRow[];
  rows.sort((a, b) => {
    const aTs = dateToSeconds(a.updatedAt) ?? 0;
    const bTs = dateToSeconds(b.updatedAt) ?? 0;
    return bTs - aTs;
  });
  await writeMemoryIndex({
    workspaceRoot,
    entries: rows.map((r) => ({
      scope: r.scope,
      key: r.key,
      hook: `rev ${r.revision} · agent ${r.agentId ?? 'system'}`,
      state: r.deletedAt ? 'tombstoned' : 'live',
    })),
  });
}

// ---------------------------------------------------------------------------
// Public API — create / update / remove
// ---------------------------------------------------------------------------

export interface CreateMemoryArgs extends WriteMemoryInput {
  db: AgentOsDb;
  blobs: BlobStore;
  workspaceRoot: string;
  clock?: Clock;
}

/**
 * Append-by-default create. Throws `MemoryExistsError` if `(scope, key)`
 * already has a live or tombstoned row — callers must use `updateMemory` to
 * change an existing entry.
 */
export async function createMemory(args: CreateMemoryArgs): Promise<MemoryEntry> {
  const clock = args.clock ?? defaultClock;
  const at = clock();

  if (typeof args.value !== 'string' || args.value.length === 0) {
    throw new MemoryWritePolicyError('createMemory: value must be a non-empty string');
  }
  // Sanitize early — this also rejects empty / unsanitizable keys/scopes.
  const scope = args.scope;
  const key = args.key;
  sanitizeScope(scope);
  sanitizeKey(key);

  const existing = await loadRow(args.db, scope, key);
  if (existing) {
    throw new MemoryExistsError(scope, key);
  }

  const valueRef = await args.blobs.write(args.value);
  const id = randomUUID();

  const embeddingId = await writeEmbeddingIfPresent(args.db, id, args.embedding);

  await args.db.insert(memory).values({
    id,
    scope,
    agentId: args.agentId ?? null,
    key,
    valueRef,
    embeddingId,
    createdAt: secondsToDate(at),
    updatedAt: secondsToDate(at),
    deletedAt: null,
    revision: 1,
    previousValueRef: null,
  });

  await writeMemoryFile({
    workspaceRoot: args.workspaceRoot,
    id,
    scope,
    key,
    agentId: args.agentId ?? null,
    revision: 1,
    createdAt: at,
    updatedAt: at,
    previousValueRef: null,
    value: args.value,
  });

  await emitEvent(
    args.db,
    'memory.created',
    {
      memory_id: id,
      scope,
      key,
      agent_id: args.agentId ?? null,
      who: args.agentId ?? 'system',
      when: at,
      revision: 1,
    },
    at,
  );

  await refreshIndex(args.db, args.workspaceRoot);

  const row = await loadRow(args.db, scope, key);
  if (!row) throw new Error('createMemory: row vanished after insert');
  return rowToEntry(row);
}

export interface UpdateMemoryArgs extends WriteMemoryInput {
  db: AgentOsDb;
  blobs: BlobStore;
  workspaceRoot: string;
  clock?: Clock;
}

/**
 * Update an existing memory. Requires `revisionIntent: 'update'` (real diff)
 * or `'overwrite'` (admin / CLI bypass). The default `'append'` is rejected
 * — appending to an existing key is a programmer error.
 */
export async function updateMemory(args: UpdateMemoryArgs): Promise<MemoryEntry> {
  const clock = args.clock ?? defaultClock;
  const at = clock();
  const intent = args.revisionIntent ?? 'append';

  if (intent === 'append') {
    throw new MemoryWritePolicyError(
      `updateMemory: revisionIntent must be 'update' or 'overwrite' (got 'append')`,
    );
  }
  if (typeof args.value !== 'string' || args.value.length === 0) {
    throw new MemoryWritePolicyError('updateMemory: value must be a non-empty string');
  }

  const prior = await loadRow(args.db, args.scope, args.key);
  if (!prior) throw new MemoryNotFoundError(args.scope, args.key);

  const newRef = await args.blobs.write(args.value);

  if (intent === 'update' && newRef === prior.valueRef) {
    throw new MemoryWritePolicyError(
      `updateMemory: new value identical to prior (sha256=${newRef.slice(0, 7)}); use 'overwrite' to bypass`,
    );
  }

  const nextRevision = prior.revision + 1;
  const embeddingId = args.embedding
    ? await writeEmbeddingIfPresent(args.db, prior.id, args.embedding)
    : prior.embeddingId;

  await args.db
    .update(memory)
    .set({
      valueRef: newRef,
      previousValueRef: prior.valueRef,
      revision: nextRevision,
      updatedAt: secondsToDate(at),
      deletedAt: null, // resurrecting a tombstoned key with an explicit update
      embeddingId,
    })
    .where(eq(memory.id, prior.id));

  await writeMemoryFile({
    workspaceRoot: args.workspaceRoot,
    id: prior.id,
    scope: prior.scope,
    key: prior.key,
    agentId: args.agentId ?? prior.agentId,
    revision: nextRevision,
    createdAt: dateToSeconds(prior.createdAt) ?? at,
    updatedAt: at,
    previousValueRef: prior.valueRef,
    value: args.value,
  });

  await emitEvent(
    args.db,
    intent === 'overwrite' ? 'memory.overwritten' : 'memory.updated',
    {
      memory_id: prior.id,
      scope: prior.scope,
      key: prior.key,
      agent_id: args.agentId ?? prior.agentId,
      who: args.agentId ?? prior.agentId ?? 'system',
      when: at,
      revision: nextRevision,
      previous_value_ref: prior.valueRef,
      diff_note: args.diffNote ?? null,
    },
    at,
  );

  await refreshIndex(args.db, args.workspaceRoot);

  const row = await loadRow(args.db, prior.scope, prior.key);
  if (!row) throw new Error('updateMemory: row vanished after update');
  return rowToEntry(row);
}

export interface RemoveMemoryArgs {
  db: AgentOsDb;
  blobs: BlobStore;
  workspaceRoot: string;
  scope: string;
  key: string;
  agentId?: string | null;
  clock?: Clock;
}

/**
 * Tombstone a memory entry. Sets `deleted_at`, rewrites the file to a
 * tombstone marker, emits `memory.removed`. The row + blob are KEPT.
 */
export async function removeMemory(args: RemoveMemoryArgs): Promise<MemoryEntry> {
  const clock = args.clock ?? defaultClock;
  const at = clock();

  const prior = await loadRow(args.db, args.scope, args.key);
  if (!prior) throw new MemoryNotFoundError(args.scope, args.key);

  await args.db
    .update(memory)
    .set({
      deletedAt: secondsToDate(at),
      updatedAt: secondsToDate(at),
    })
    .where(eq(memory.id, prior.id));

  await removeMemoryFile({
    workspaceRoot: args.workspaceRoot,
    scope: prior.scope,
    key: prior.key,
    tombstonedAt: new Date(at * 1000).toISOString(),
  });

  await emitEvent(
    args.db,
    'memory.removed',
    {
      memory_id: prior.id,
      scope: prior.scope,
      key: prior.key,
      agent_id: args.agentId ?? prior.agentId,
      who: args.agentId ?? prior.agentId ?? 'system',
      when: at,
      revision: prior.revision,
    },
    at,
  );

  await refreshIndex(args.db, args.workspaceRoot);

  const row = await loadRow(args.db, prior.scope, prior.key);
  if (!row) throw new Error('removeMemory: row vanished after tombstone');
  return rowToEntry(row);
}

// ---------------------------------------------------------------------------
// Public API — read / list / search
// ---------------------------------------------------------------------------

export interface GetMemoryArgs {
  db: AgentOsDb;
  scope: string;
  key: string;
  includeDeleted?: boolean;
}

export async function getMemory(args: GetMemoryArgs): Promise<MemoryEntry | null> {
  const row = await loadRow(args.db, args.scope, args.key);
  if (!row) return null;
  if (!args.includeDeleted && row.deletedAt) return null;
  return rowToEntry(row);
}

export interface ListMemoryArgs {
  db: AgentOsDb;
  scope?: string;
  agentId?: string | null;
  includeDeleted?: boolean;
}

/**
 * Enumerate memory entries, sorted by `updated_at DESC`. Tombstoned rows are
 * filtered out unless `includeDeleted=true`.
 */
export async function listMemory(args: ListMemoryArgs): Promise<MemoryEntry[]> {
  const rows = (await args.db.select().from(memory)) as MemoryRow[];
  let filtered = rows;
  if (args.scope !== undefined) {
    filtered = filtered.filter((r) => r.scope === args.scope);
  }
  if (args.agentId !== undefined) {
    filtered = filtered.filter((r) => r.agentId === args.agentId);
  }
  if (!args.includeDeleted) {
    filtered = filtered.filter((r) => r.deletedAt === null);
  }
  filtered.sort((a, b) => {
    const aTs = dateToSeconds(a.updatedAt) ?? 0;
    const bTs = dateToSeconds(b.updatedAt) ?? 0;
    return bTs - aTs;
  });
  return filtered.map(rowToEntry);
}

export interface SearchMemoryArgs extends SearchMemoryInput {
  db: AgentOsDb;
  blobs: BlobStore;
}

/**
 * Search live memories. If `input.embedding` is provided AND sqlite-vec is
 * available, semantic ANN is used; otherwise a lexical token-overlap
 * fallback runs over up to 50 candidate blobs.
 *
 * Tombstoned rows are always filtered out.
 */
export async function searchMemory(args: SearchMemoryArgs): Promise<MemorySearchResult[]> {
  const topK = args.topK ?? 10;
  const scopes =
    args.scope === undefined ? undefined : Array.isArray(args.scope) ? args.scope : [args.scope];

  // Try semantic mode first.
  if (args.embedding && args.embedding.length > 0) {
    const semantic = await searchSemantic(args.db, args.embedding, scopes, args.agentId, topK);
    if (semantic !== null) return semantic;
    // Fall through to lexical on failure.
  }

  return searchLexical({
    db: args.db,
    blobs: args.blobs,
    query: args.query,
    scopes,
    agentId: args.agentId ?? undefined,
    topK,
  });
}

async function searchSemantic(
  db: AgentOsDb,
  embedding: number[],
  scopes: string[] | undefined,
  agentId: string | null | undefined,
  topK: number,
): Promise<MemorySearchResult[] | null> {
  try {
    // Capability check: vec_distance_cosine is a sqlite-vec function. If the
    // extension is not loaded the prepare() call throws and we return null so
    // the caller falls back to lexical mode.
    const sqlite = db.$sqlite;
    const queryBuf = Buffer.from(new Float32Array(embedding).buffer);
    const rows = sqlite
      .prepare(
        `SELECT m.id AS id, m.scope AS scope, m.agent_id AS agentId,
                m.key AS key, m.value_ref AS valueRef,
                m.embedding_id AS embeddingId,
                m.created_at AS createdAt, m.updated_at AS updatedAt,
                m.deleted_at AS deletedAt, m.revision AS revision,
                m.previous_value_ref AS previousValueRef,
                vec_distance_cosine(e.vector, ?) AS distance
         FROM memory m
         JOIN embeddings e ON e.id = m.embedding_id
         WHERE m.deleted_at IS NULL
         ORDER BY distance ASC
         LIMIT ?`,
      )
      .all(queryBuf, topK * 4) as Array<MemoryRow & { distance: number }>;

    const filtered = rows.filter((r) => {
      if (scopes && !scopes.includes(r.scope)) return false;
      if (agentId !== undefined && r.agentId !== agentId) return false;
      return true;
    });

    const top = filtered.slice(0, topK);
    return top.map((r) => ({
      entry: rowToEntry({
        ...r,
        createdAt: r.createdAt ? new Date((r.createdAt as unknown as number) * 1000) : null,
        updatedAt: r.updatedAt ? new Date((r.updatedAt as unknown as number) * 1000) : null,
        deletedAt: r.deletedAt ? new Date((r.deletedAt as unknown as number) * 1000) : null,
      }),
      // Cosine distance ∈ [0, 2]; map to similarity score in [0, 1].
      score: Math.max(0, 1 - r.distance / 2),
      snippet: '',
    }));
  } catch {
    return null;
  }
}

interface LexicalSearchArgs {
  db: AgentOsDb;
  blobs: BlobStore;
  query: string;
  scopes: string[] | undefined;
  agentId: string | undefined;
  topK: number;
}

async function searchLexical(args: LexicalSearchArgs): Promise<MemorySearchResult[]> {
  const rows = (await args.db.select().from(memory).where(isNull(memory.deletedAt))) as MemoryRow[];

  let candidates = rows;
  if (args.scopes) {
    candidates = candidates.filter((r) => args.scopes!.includes(r.scope));
  }
  if (args.agentId !== undefined) {
    candidates = candidates.filter((r) => r.agentId === args.agentId);
  }

  candidates.sort((a, b) => {
    const aTs = dateToSeconds(a.updatedAt) ?? 0;
    const bTs = dateToSeconds(b.updatedAt) ?? 0;
    return bTs - aTs;
  });
  candidates = candidates.slice(0, 50);

  const tokens = tokenize(args.query);
  if (tokens.length === 0) {
    return candidates.slice(0, args.topK).map((r) => ({
      entry: rowToEntry(r),
      score: 0,
      snippet: '',
    }));
  }

  const scored: MemorySearchResult[] = [];
  for (const row of candidates) {
    let body = '';
    try {
      const buf = await args.blobs.read(row.valueRef);
      body = buf.toString('utf8');
    } catch {
      // Missing blob → skip; the row remains in the index but has no
      // searchable content.
      continue;
    }
    const bodyTokens = tokenize(body);
    if (bodyTokens.length === 0) continue;
    const bodySet = new Set(bodyTokens);
    let hits = 0;
    for (const t of tokens) {
      if (bodySet.has(t)) hits += 1;
    }
    if (hits === 0) continue;
    const score = hits / tokens.length;
    scored.push({
      entry: rowToEntry(row),
      score,
      snippet: snippetFor(body, tokens),
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, args.topK);
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

function snippetFor(body: string, tokens: string[]): string {
  const lower = body.toLowerCase();
  for (const t of tokens) {
    const idx = lower.indexOf(t);
    if (idx >= 0) {
      const start = Math.max(0, idx - 40);
      const end = Math.min(body.length, idx + t.length + 40);
      const prefix = start > 0 ? '…' : '';
      const suffix = end < body.length ? '…' : '';
      return prefix + body.slice(start, end).replace(/\s+/g, ' ') + suffix;
    }
  }
  return body.slice(0, 80).replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------
// Convenience: read the live value bytes for an entry
// ---------------------------------------------------------------------------

export interface ReadMemoryValueArgs {
  blobs: BlobStore;
  workspaceRoot?: string;
  entry: MemoryEntry;
}

/**
 * Resolve a memory entry's current value. Prefers the blob store (canonical)
 * and falls back to the on-disk markdown if the blob is missing.
 */
export async function readMemoryValue(args: ReadMemoryValueArgs): Promise<string> {
  try {
    const buf = await args.blobs.read(args.entry.valueRef);
    return buf.toString('utf8');
  } catch {
    if (args.workspaceRoot) {
      const file = await readMemoryFile({
        workspaceRoot: args.workspaceRoot,
        scope: args.entry.scope,
        key: args.entry.key,
      });
      if (file !== null) return file;
    }
    throw new Error(
      `readMemoryValue: blob ${args.entry.valueRef.slice(0, 7)} not found and no fallback file`,
    );
  }
}

// ---------------------------------------------------------------------------
// Barrel re-exports
// ---------------------------------------------------------------------------

export type {
  MemoryAction,
  MemoryEntry,
  MemorySearchResult,
  SearchMemoryInput,
  WriteMemoryInput,
} from './types.js';

export { enforceMemoryAccess, enforceMemoryAccessOrThrow, MemoryPolicyDenied } from './policy.js';
export type { EnforceMemoryAccessArgs, MemoryEventLogger, MemoryPolicyDecision } from './policy.js';

export {
  memoryFilePath,
  readMemoryFile,
  removeMemoryFile,
  sanitizeKey,
  sanitizeScope,
  writeMemoryFile,
  writeMemoryIndex,
} from './files.js';
