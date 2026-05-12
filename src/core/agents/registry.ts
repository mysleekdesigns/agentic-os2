/**
 * Registry sync — reconciles in-memory agent definitions with the `agents`
 * SQLite table (PRD §2.4). The on-disk markdown files remain the source of
 * truth; this table is a pointer index used for cache invalidation and audit.
 *
 * Sync is a single SQLite transaction so a half-applied registry is never
 * visible to concurrent readers.
 */

import { eq } from 'drizzle-orm';

import type { AgentOsDb } from '../../storage/db.js';
import { agents } from '../../storage/schema.js';
import type { AgentDefinition } from './loader.js';

export interface RegistryUpsertResult {
  inserted: number;
  updated: number;
  unchanged: number;
}

/**
 * Reconcile `defs` against the `agents` table.
 *
 * - New `id`            → INSERT
 * - Existing, same hash → no-op
 * - Existing, new hash  → UPDATE hash/version/definition_path, keep created_at
 *
 * The `version` column is a TEXT field per the existing schema, so the integer
 * `frontmatter.version` is stringified on the way in.
 */
export async function syncRegistry(
  db: AgentOsDb,
  defs: AgentDefinition[],
): Promise<RegistryUpsertResult> {
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;

  const sqlite = db.$sqlite;
  sqlite.exec('BEGIN');
  try {
    for (const def of defs) {
      const fm = def.frontmatter;
      const existing = await db.select().from(agents).where(eq(agents.id, fm.id));

      if (existing.length === 0) {
        await db.insert(agents).values({
          id: fm.id,
          version: String(fm.version),
          definitionPath: def.path,
          hash: def.hash,
          createdAt: new Date(),
        });
        inserted++;
        continue;
      }

      const row = existing[0]!;
      if (row.hash === def.hash) {
        unchanged++;
        continue;
      }

      await db
        .update(agents)
        .set({
          hash: def.hash,
          version: String(fm.version),
          definitionPath: def.path,
        })
        .where(eq(agents.id, fm.id));
      updated++;
    }
    sqlite.exec('COMMIT');
  } catch (err) {
    sqlite.exec('ROLLBACK');
    throw err;
  }

  return { inserted, updated, unchanged };
}
