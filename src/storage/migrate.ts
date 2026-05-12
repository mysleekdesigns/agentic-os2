/**
 * Hand-rolled migration runner for the Agent OS SQLite database.
 *
 * Why hand-rolled instead of `drizzle-kit migrate`?
 * - We author the SQL by hand (PRD §2.4 requires CHECK constraints and a
 *   conditional virtual `vec0` table that drizzle-kit can't express cleanly).
 * - We need a runtime gate on the embeddings migration that retries on a
 *   later boot once `sqlite-vec` becomes available.
 *
 * Bookkeeping: every migration file's basename is recorded in
 * `_agent_os_migrations(name, applied_at, status)`. A `skipped` row signals
 * that the migration should be retried next boot.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AgentOsDb } from './db.js';
import { openDatabase } from './db.js';
import { tryLoadVec } from './vec.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Default migrations directory. Resolved relative to the source file so it
 * works under tsx (dev) and compiled dist (prod).
 *
 * Source layout: `<repo>/src/storage/migrate.ts` → `<repo>/drizzle/migrations`
 * Build layout:  `<repo>/dist/storage/migrate.js` → `<repo>/drizzle/migrations`
 */
export const DEFAULT_MIGRATIONS_DIR = resolve(__dirname, '..', '..', 'drizzle', 'migrations');

export interface MigrationOutcome {
  name: string;
  status: 'applied' | 'skipped' | 'already-applied';
  reason?: string;
}

export interface MigrateOptions {
  /** Override the migrations directory (handy in tests). */
  migrationsDir?: string;
  /** Optional sink for human-readable progress lines (defaults to stderr). */
  log?: (line: string) => void;
}

/**
 * Apply all pending migrations against the given Drizzle/SQLite handle.
 *
 * Returns one outcome per migration file in lexicographic order. Idempotent:
 * re-running yields `already-applied` for finished migrations and retries
 * any `skipped` ones (notably the sqlite-vec embeddings migration).
 */
export async function runMigrations(
  db: AgentOsDb,
  options: MigrateOptions = {},
): Promise<MigrationOutcome[]> {
  const dir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  const log = options.log ?? ((line: string) => process.stderr.write(line + '\n'));
  const sqlite = db.$sqlite;

  ensureBookkeepingTable(db);

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));

  const outcomes: MigrationOutcome[] = [];

  for (const file of files) {
    const name = basename(file, '.sql');
    const prior = sqlite
      .prepare('SELECT status FROM _agent_os_migrations WHERE name = ?')
      .get(name) as { status?: string } | undefined;

    if (prior?.status === 'applied') {
      outcomes.push({ name, status: 'already-applied' });
      continue;
    }

    const sql = readFileSync(join(dir, file), 'utf8');

    // The embeddings vec migration is conditional on sqlite-vec being
    // loadable. Detect via filename — keeps the gate explicit and avoids
    // sniffing SQL contents.
    const needsVec = name === '0002_embeddings_vec';
    if (needsVec) {
      const vec = await tryLoadVec(db);
      if (!vec.available) {
        log(
          `[migrate] skipping ${name}: sqlite-vec unavailable (${vec.reason ?? 'unknown reason'})`,
        );
        recordOutcome(db, name, 'skipped', vec.reason);
        outcomes.push({
          name,
          status: 'skipped',
          reason: vec.reason,
        });
        continue;
      }
    }

    log(`[migrate] applying ${name}`);
    sqlite.exec('BEGIN');
    try {
      sqlite.exec(sql);
      recordOutcome(db, name, 'applied');
      sqlite.exec('COMMIT');
    } catch (err) {
      sqlite.exec('ROLLBACK');
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Migration ${name} failed: ${reason}`);
    }

    outcomes.push({ name, status: 'applied' });
  }

  return outcomes;
}

function ensureBookkeepingTable(db: AgentOsDb): void {
  db.$sqlite.exec(
    `CREATE TABLE IF NOT EXISTS _agent_os_migrations (
       name        TEXT PRIMARY KEY,
       applied_at  INTEGER NOT NULL,
       status      TEXT NOT NULL DEFAULT 'applied'
     )`,
  );
}

function recordOutcome(
  db: AgentOsDb,
  name: string,
  status: 'applied' | 'skipped',
  reason?: string,
): void {
  // For skipped migrations we still upsert so we know *why* on inspection,
  // and so the runner can retry on the next invocation by overwriting the
  // row when it transitions to 'applied'.
  const now = Math.floor(Date.now() / 1000);
  const reasonField = reason ? ` (${reason})` : '';
  db.$sqlite
    .prepare(
      `INSERT INTO _agent_os_migrations (name, applied_at, status)
         VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           applied_at = excluded.applied_at,
           status     = excluded.status`,
    )
    .run(name, now, status + reasonField);
}

// ---------------------------------------------------------------------------
// CLI entry point: `npm run db:migrate`
// ---------------------------------------------------------------------------

function isMain(): boolean {
  if (!process.argv[1]) return false;
  try {
    return resolve(process.argv[1]) === __filename;
  } catch {
    return false;
  }
}

if (isMain()) {
  const dbPath = process.env.AGENT_OS_DB ?? '.agent-os/agent-os.sqlite';
  const db = openDatabase(dbPath);
  runMigrations(db)
    .then((outcomes) => {
      for (const o of outcomes) {
        process.stdout.write(`${o.name}: ${o.status}${o.reason ? ` (${o.reason})` : ''}\n`);
      }
      db.$sqlite.close();
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`agent-os migrate: ${message}\n`);
      db.$sqlite.close();
      process.exit(1);
    });
}
