/**
 * SQLite connection helper for the Agent OS storage layer.
 *
 * Thin wrapper around `better-sqlite3` + `drizzle-orm` that:
 * - Applies a sensible set of pragmas (WAL, foreign keys on).
 * - Returns the underlying `Database` so callers that need to load
 *   extensions or run raw SQL (e.g. the migrate runner, sqlite-vec loader)
 *   can do so.
 *
 * PRD §2.4 / §5: default storage backend is `better-sqlite3`.
 */

import Database from 'better-sqlite3';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import * as schema from './schema.js';

export type AgentOsDb = BetterSQLite3Database<typeof schema> & {
  $sqlite: BetterSqlite3Database;
};

export interface OpenDatabaseOptions {
  /**
   * When true, attempts to enable `loadExtension`. Required for sqlite-vec.
   * Some build flavours of better-sqlite3 ship without this support; we set
   * it best-effort and silently ignore failure (caller can introspect via
   * `db.$sqlite.loadExtension` presence).
   */
  allowExtensions?: boolean;
  /** Skip WAL mode (useful for `:memory:` or read-only diagnostic opens). */
  noWal?: boolean;
}

/**
 * Open a SQLite database and return a Drizzle handle augmented with the raw
 * better-sqlite3 connection at `$sqlite`.
 *
 * Pure-ish: no global state, no module-level cache. Callers own the lifetime
 * of the returned handle and should `db.$sqlite.close()` when done.
 *
 * @param path Filesystem path or `:memory:` for an in-memory DB.
 * @param options See {@link OpenDatabaseOptions}.
 */
export function openDatabase(path: string, options: OpenDatabaseOptions = {}): AgentOsDb {
  const sqlite = new Database(path);

  if (options.allowExtensions !== false) {
    // `allowExtension` is a runtime flag on the better-sqlite3 Database
    // object; toggling it permits `loadExtension` calls afterwards.
    try {
      // The cast is intentional: this method exists on the better-sqlite3
      // instance but isn't always present in the type definitions for older
      // @types versions.
      (
        sqlite as unknown as {
          loadExtension?: unknown;
          unsafeMode?: (enabled: boolean) => void;
        }
      ).unsafeMode?.(false);
    } catch {
      // Best effort — extension loading may simply be unavailable.
    }
  }

  // Standard pragmas for an embedded app workload.
  sqlite.pragma('foreign_keys = ON');
  if (path !== ':memory:' && !options.noWal) {
    try {
      sqlite.pragma('journal_mode = WAL');
    } catch {
      // Non-fatal: some filesystems (e.g. network mounts) reject WAL.
    }
  }

  const db = drizzle(sqlite, { schema }) as unknown as AgentOsDb;
  // Attach the raw handle so migrate/vec loaders can issue exec/loadExtension.
  Object.defineProperty(db, '$sqlite', {
    value: sqlite,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return db;
}
