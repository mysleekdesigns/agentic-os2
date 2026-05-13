import 'server-only';

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { openDatabase, type AgentOsDb } from '@agent-os/core/storage/db.js';

let cached: AgentOsDb | null = null;

/**
 * Resolve the path to the Agent OS SQLite database.
 *
 * Honours `AGENT_OS_DB` (set by the `agent-os dashboard` launcher). When unset,
 * falls back to `<cwd>/../.agent-os/agent-os.sqlite` — `next start` invoked
 * from `web/` puts cwd at `web/`, so the DB sits one level up at the
 * workspace root.
 */
export function resolveDbPath(): string {
  return process.env.AGENT_OS_DB ?? join(process.cwd(), '..', '.agent-os', 'agent-os.sqlite');
}

/**
 * Open (and memoise) a read-only-ish handle to the Agent OS SQLite database
 * for the lifetime of the Next.js server process. The dashboard is read-only;
 * we keep one connection open and reuse it across requests for cheap reads.
 *
 * Throws if the database file does not exist — callers should catch and
 * render a "database not found" empty state.
 */
export function getDb(): AgentOsDb {
  if (cached) return cached;
  const dbPath = resolveDbPath();
  if (!existsSync(dbPath)) {
    throw new Error(
      `Agent OS database not found at ${dbPath}. Run \`agent-os doctor\` from the workspace root.`,
    );
  }
  cached = openDatabase(dbPath);
  return cached;
}
