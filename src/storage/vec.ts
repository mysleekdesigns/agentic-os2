/**
 * Best-effort loader for the `sqlite-vec` SQLite extension.
 *
 * The Agent OS storage layer treats vector search as an optional capability
 * (see PRD §2.4 and Phase 1). When the extension cannot be loaded — because
 * the package is not installed, the build of better-sqlite3 disallows
 * extensions, or the OS bundle is missing — we degrade gracefully and surface
 * the reason in `StorageCapabilities`.
 *
 * `tryLoadVec` MUST NOT throw. Callers should treat a `false` result as a
 * normal runtime condition.
 */

import type { AgentOsDb } from './db.js';

export interface VecLoadResult {
  available: boolean;
  reason?: string;
}

interface SqliteVecModule {
  load: (db: unknown) => void;
}

/**
 * Attempt to load sqlite-vec into the given database connection.
 *
 * Order of operations:
 * 1. Verify the raw better-sqlite3 handle exposes `loadExtension`.
 * 2. Try to dynamically import the `sqlite-vec` npm package.
 * 3. Call its `load(db)` helper.
 * 4. Verify the extension actually responded by issuing a `vec_version()`
 *    pragma-equivalent query.
 *
 * Any failure returns `{ available: false, reason }` — never throws.
 */
export async function tryLoadVec(db: AgentOsDb): Promise<VecLoadResult> {
  const sqlite = db.$sqlite;

  if (typeof sqlite.loadExtension !== 'function') {
    return {
      available: false,
      reason: 'better-sqlite3 build does not support loadExtension',
    };
  }

  let vec: SqliteVecModule;
  try {
    // Dynamic import keeps this optional: if the package isn't installed we
    // fall through to the catch arm without breaking module loading.
    vec = (await import('sqlite-vec')) as unknown as SqliteVecModule;
  } catch (err) {
    return {
      available: false,
      reason: `sqlite-vec module not importable: ${stringifyError(err)}`,
    };
  }

  try {
    vec.load(sqlite);
  } catch (err) {
    return {
      available: false,
      reason: `sqlite-vec load failed: ${stringifyError(err)}`,
    };
  }

  // Confirm the extension is actually wired up. `vec_version()` is the
  // canonical smoke-test query exposed by sqlite-vec.
  try {
    const row = sqlite.prepare('SELECT vec_version() AS version').get() as
      | { version?: string }
      | undefined;
    if (!row?.version) {
      return {
        available: false,
        reason: 'sqlite-vec loaded but vec_version() returned no row',
      };
    }
  } catch (err) {
    return {
      available: false,
      reason: `sqlite-vec smoke test failed: ${stringifyError(err)}`,
    };
  }

  return { available: true };
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
