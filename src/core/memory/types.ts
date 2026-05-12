/**
 * Memory engine types (PRD §3 Phase 7).
 *
 * Pure data types — no Drizzle / fs dependencies. The engine (`./index.ts`)
 * maps these to the `memory` table and file-backed markdown blobs; the policy
 * module (`./policy.ts`) enforces per-agent allow-lists.
 *
 * Write policy reminders (full prose in `./index.ts`):
 *   - append is the default for additive memories (`createMemory`).
 *   - updates require an explicit `revisionIntent: 'update'` and an existing
 *     entry to diff against; a `previous_value_ref` chain is recorded.
 *   - deletes are tombstoned (`deleted_at` set; row + blob retained).
 */

export interface MemoryEntry {
  id: string;
  scope: string;
  agentId: string | null;
  key: string;
  /** sha256 of the current value blob. */
  valueRef: string;
  /** sha256 of the prior value blob; null on the initial revision. */
  previousValueRef: string | null;
  revision: number;
  embeddingId: string | null;
  /** Unix epoch seconds. */
  createdAt: number;
  /** Unix epoch seconds. */
  updatedAt: number;
  /** Unix epoch seconds; null = live, non-null = tombstoned. */
  deletedAt: number | null;
}

export interface WriteMemoryInput {
  scope: string;
  agentId?: string | null;
  key: string;
  /** Markdown body — the engine hashes it and persists the blob. */
  value: string;
  /** Optional semantic-search vector. */
  embedding?: number[];
  /**
   * Intent for `updateMemory`. Default is `'append'`, which is REJECTED by
   * `updateMemory` — appending an existing key is a programmer error; callers
   * who want to add a fresh entry should pick a new key.
   *
   * - `'update'`  : new content must differ from the prior value (real diff).
   * - `'overwrite'`: bypasses the differ check; reserved for CLI/admin paths.
   */
  revisionIntent?: 'append' | 'update' | 'overwrite';
  /** Optional note recorded on the `memory.updated` event row. */
  diffNote?: string;
}

export interface SearchMemoryInput {
  query: string;
  scope?: string | string[];
  agentId?: string | null;
  topK?: number;
  /** When provided AND sqlite-vec is available, semantic ANN is used. */
  embedding?: number[];
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  /** 0..1 — higher = more relevant. */
  score: number;
  snippet: string;
}

/**
 * The action verbs gated by `enforceMemoryAccess`. CLI commands and the
 * provider boundary map their high-level operations onto these.
 */
export type MemoryAction = 'list' | 'show' | 'read' | 'write' | 'rm' | 'search';
