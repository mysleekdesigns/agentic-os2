/**
 * `agent-os logs` — Phase 8 observability surface.
 *
 * Searchable, reverse-chronological tail of the `events` table — the workspace
 * log stream. Each row in `events` has `{id, kind, payload (JSON string),
 * created_at}`. Approvals, memory writes, and other state transitions all emit
 * here, so `events` is the closest thing Agent OS has to a unified log.
 *
 * Flags:
 *   --agent <id>       Filter events whose payload contains the agent id, OR
 *                      whose owning run has matching `runs.agent_id`. We use
 *                      a `LIKE '%"agent_id":"<id>"%'` predicate on payload —
 *                      it's robust for SQLite builds without the JSON1
 *                      extension, and 1:1 with how upstream emitters
 *                      JSON.stringify their payloads (compact, no whitespace).
 *   --since <ISO|rel>  ISO timestamp (`2026-05-12T18:00:00Z`) or relative
 *                      duration (`5m`, `1h`, `2d`). Converted to an epoch
 *                      cutoff and applied via `created_at >= ?`.
 *   --kind <k>         Repeatable. Filters to one or more event kinds.
 *   --limit <n>        Default 50.
 *   --json             JSONL output (one event per line).
 *
 * `--follow` is explicitly OUT OF SCOPE for Phase 8; tracked for Phase 13+
 * once a streaming subscription API exists.
 *
 * Local-first: reads only from the workspace SQLite DB.
 */

import { resolve, isAbsolute, join } from 'node:path';
import { Command } from 'commander';
import { and, desc, eq, gte, inArray, like, or, type SQL } from 'drizzle-orm';

import { loadConfig } from '../../config/index.js';
import { openDatabase, type AgentOsDb } from '../../storage/db.js';
import { runMigrations } from '../../storage/migrate.js';
import { events, runs } from '../../storage/schema.js';

// ---------------------------------------------------------------------------
// Workspace / DB helpers
// ---------------------------------------------------------------------------

function resolveWorkspaceRoot(cwd: string): string {
  const config = loadConfig(undefined, { env: process.env });
  const raw = config.runtime.workspace_root;
  return isAbsolute(raw) ? raw : resolve(cwd, raw);
}

function defaultDbPath(workspace: string): string {
  return process.env.AGENT_OS_DB ?? join(workspace, '.agent-os', 'db.sqlite');
}

async function openWorkspaceDb(workspace: string): Promise<AgentOsDb> {
  const dbPath = defaultDbPath(workspace);
  const db = openDatabase(dbPath);
  try {
    await runMigrations(db, { log: () => undefined });
  } catch (err) {
    db.$sqlite.close();
    throw err;
  }
  return db;
}

// ---------------------------------------------------------------------------
// --since parsing
// ---------------------------------------------------------------------------

const RELATIVE_RE = /^(\d+)\s*(s|m|h|d)$/i;

export function parseSince(value: string, now: number = Date.now()): Date {
  const trimmed = value.trim();
  const rel = RELATIVE_RE.exec(trimmed);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]!.toLowerCase();
    const factor =
      unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
    return new Date(now - n * factor);
  }
  // Otherwise parse as ISO.
  const t = Date.parse(trimmed);
  if (Number.isNaN(t)) {
    throw new Error(`--since: cannot parse "${value}" as ISO timestamp or relative duration`);
  }
  return new Date(t);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function summarisePayload(raw: string, max = 120): string {
  // Collapse JSON whitespace for compact one-line rendering; tolerate non-JSON.
  let s: string;
  try {
    const parsed: unknown = JSON.parse(raw);
    s = JSON.stringify(parsed);
  } catch {
    s = raw.replace(/\s+/g, ' ');
  }
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

interface LogRow {
  id: string;
  kind: string;
  created_at: number;
  payload: string;
}

function renderRow(row: LogRow): string {
  const ts = new Date(row.created_at).toISOString();
  return `${ts}  ${row.kind}  ${summarisePayload(row.payload)}`;
}

// ---------------------------------------------------------------------------
// Command implementation
// ---------------------------------------------------------------------------

interface LogsCliOptions {
  agent?: string;
  since?: string;
  kind?: string[];
  limit?: string;
  json?: boolean;
}

export async function logsCommand(cwd: string, opts: LogsCliOptions): Promise<number> {
  const workspace = resolveWorkspaceRoot(cwd);

  const limitNum = opts.limit !== undefined ? Number(opts.limit) : 50;
  if (!Number.isFinite(limitNum) || limitNum <= 0) {
    process.stderr.write(`agent-os logs: --limit must be a positive integer\n`);
    return 1;
  }

  let sinceDate: Date | null = null;
  if (opts.since !== undefined) {
    try {
      sinceDate = parseSince(opts.since);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`agent-os logs: ${message}\n`);
      return 1;
    }
  }

  const db = await openWorkspaceDb(workspace);
  try {
    // Build WHERE clauses additively.
    const clauses: SQL[] = [];
    if (sinceDate) clauses.push(gte(events.createdAt, sinceDate));
    if (opts.kind && opts.kind.length > 0) {
      clauses.push(inArray(events.kind, opts.kind));
    }
    if (opts.agent) {
      // payload is JSON.stringify of an object; "agent_id":"<id>" survives
      // unless the value contains a quote. We also union in events created
      // during a run whose runs.agent_id matches.
      const agentRuns = await db
        .select({ id: runs.id })
        .from(runs)
        .where(eq(runs.agentId, opts.agent));
      const runIds = agentRuns.map((r) => r.id);

      const agentIdLike = like(events.payload, `%"agent_id":"${opts.agent}"%`);
      if (runIds.length > 0) {
        const runIdLike = inArray(
          events.payload,
          // dummy noop — we'll just OR several LIKEs below
          [],
        );
        // Use OR over agent_id LIKE and each run_id LIKE.
        const runLikes = runIds.map((id) => like(events.payload, `%"run_id":"${id}"%`));
        // drizzle's or() accepts variadic SQL
        const combined = or(agentIdLike, ...runLikes);
        if (combined) clauses.push(combined);
        // satisfy ts: avoid unused
        void runIdLike;
      } else {
        clauses.push(agentIdLike);
      }
    }

    const whereExpr =
      clauses.length === 0 ? undefined : clauses.length === 1 ? clauses[0]! : and(...clauses);

    const rowsQuery = db
      .select({
        id: events.id,
        kind: events.kind,
        createdAt: events.createdAt,
        payload: events.payload,
      })
      .from(events);

    const rows = whereExpr
      ? await rowsQuery.where(whereExpr).orderBy(desc(events.createdAt)).limit(limitNum)
      : await rowsQuery.orderBy(desc(events.createdAt)).limit(limitNum);

    const shaped: LogRow[] = rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      created_at: r.createdAt instanceof Date ? r.createdAt.getTime() : Number(r.createdAt),
      payload: r.payload,
    }));

    if (opts.json) {
      for (const r of shaped) {
        process.stdout.write(JSON.stringify(r) + '\n');
      }
      return 0;
    }

    if (shaped.length === 0) {
      process.stdout.write('no events match\n');
      return 0;
    }

    for (const r of shaped) {
      process.stdout.write(renderRow(r) + '\n');
    }
    return 0;
  } finally {
    db.$sqlite.close();
  }
}

// ---------------------------------------------------------------------------
// Command wiring
// ---------------------------------------------------------------------------

export function buildLogsCommand(): Command {
  const cmd = new Command('logs')
    .description('Show a reverse-chronological tail of workspace events (logs)')
    .option('--agent <id>', 'Filter events for a specific agent id')
    .option(
      '--since <iso-or-relative>',
      'Cutoff timestamp: ISO 8601 (e.g. 2026-05-12T18:00:00Z) or relative (e.g. 5m, 1h, 2d)',
    )
    .option(
      '--kind <kind>',
      'Filter by event kind (repeatable)',
      (value: string, prev: string[] = []) => prev.concat(value),
      [] as string[],
    )
    .option('--limit <n>', 'Max number of events to return (default 50)', '50')
    .option('--json', 'Emit JSONL (one event per line)', false)
    .action(async (options: LogsCliOptions) => {
      let code: number;
      try {
        code = await logsCommand(process.cwd(), options);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`agent-os logs: ${message}\n`);
        code = 1;
      }
      if (code !== 0) process.exit(code);
    });
  return cmd;
}
