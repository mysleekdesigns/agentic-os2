/**
 * `agent-os approvals` command group: list / inspect / decide approval
 * requests sitting in the queue from PRD §3 Phase 6.
 *
 * Reads-side commands open the same SQLite database the executor writes into
 * (`<workspace>/.agent-os/db.sqlite`, mirroring `workflow.ts`/`run.ts`), run
 * migrations idempotently, then call into `src/core/approvals` for all logic.
 * This file only formats input/output; the queue semantics live in the core.
 *
 * Canonical reference: PRD §3 Phase 6.
 */

import { resolve, isAbsolute, join } from 'node:path';
import { Command } from 'commander';
import { like } from 'drizzle-orm';

import { loadConfig } from '../../config/index.js';
import {
  decideRequest,
  expireDueRequests,
  getRequest,
  listRequests,
  type ApprovalRequest,
} from '../../core/approvals/index.js';
import { openDatabase, type AgentOsDb } from '../../storage/db.js';
import { runMigrations } from '../../storage/migrate.js';
import { events } from '../../storage/schema.js';

// ---------------------------------------------------------------------------
// Workspace / DB helpers (mirrors workflow.ts conventions)
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
// Table formatter (matches agent.ts / workflow.ts look-and-feel)
// ---------------------------------------------------------------------------

function formatTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((h, col) => {
    let w = h.length;
    for (const row of rows) {
      const cell = row[col] ?? '';
      if (cell.length > w) w = cell.length;
    }
    return w;
  });
  const pad = (cells: readonly string[]) =>
    cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!))).join('  ');
  const lines: string[] = [];
  lines.push(pad(headers));
  for (const row of rows) lines.push(pad(row));
  return lines.join('\n') + '\n';
}

function shortId(id: string): string {
  // Mirror the convention used elsewhere: first 8 chars of a uuid-ish id.
  return id.length <= 8 ? id : id.slice(0, 8);
}

function isoSecondsToShort(seconds: number | null): string {
  if (seconds === null) return '—';
  return new Date(seconds * 1000)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, 'Z');
}

function relativeFromNow(seconds: number | null, nowSeconds: number): string {
  if (seconds === null) return '—';
  const delta = seconds - nowSeconds;
  if (delta <= 0) return 'expired';
  if (delta < 60) return `${delta}s`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h`;
  return `${Math.floor(delta / 86400)}d`;
}

// ---------------------------------------------------------------------------
// `approvals list`
// ---------------------------------------------------------------------------

interface ListCliOptions {
  json?: boolean;
  all?: boolean;
}

async function runList(cwd: string, opts: ListCliOptions): Promise<void> {
  const workspace = resolveWorkspaceRoot(cwd);
  const db = await openWorkspaceDb(workspace);
  try {
    // Lazily transition due rows so what we print is fresh.
    await expireDueRequests({ db });
    const rows = await listRequests({ db, includeExpired: opts.all === true });

    if (opts.json) {
      process.stdout.write(JSON.stringify(rows) + '\n');
      return;
    }

    if (rows.length === 0) {
      process.stdout.write('No approval requests.\n');
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const tableRows = rows.map((r) => [
      shortId(r.id),
      r.status,
      r.runId ? shortId(r.runId) : '—',
      r.action,
      r.requestedBy,
      isoSecondsToShort(r.requestedAt),
      relativeFromNow(r.expiresAt, now),
    ]);
    process.stdout.write(
      formatTable(
        ['ID', 'STATUS', 'RUN_ID', 'ACTION', 'REQUESTED_BY', 'REQUESTED_AT', 'EXPIRES_IN'],
        tableRows,
      ),
    );
  } finally {
    db.$sqlite.close();
  }
}

// ---------------------------------------------------------------------------
// `approvals show <id>`
// ---------------------------------------------------------------------------

interface ShowCliOptions {
  json?: boolean;
}

interface RelatedEvent {
  id: string;
  kind: string;
  payload: unknown;
  created_at: number | null;
}

interface ShowPayload {
  approval: ApprovalRequest;
  events: RelatedEvent[];
}

/**
 * Find events whose JSON payload references this approval id. The event-log
 * uses `"approval_id":"<uuid>"` consistently (see `core/approvals/index.ts`),
 * so a simple `LIKE` is sufficient and avoids JSON1 dependence.
 */
async function fetchRelatedEvents(db: AgentOsDb, approvalId: string): Promise<RelatedEvent[]> {
  const needle = `%"approval_id":"${approvalId}"%`;
  const rows = await db.select().from(events).where(like(events.payload, needle));
  return rows
    .map((r) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(r.payload);
      } catch {
        parsed = r.payload;
      }
      return {
        id: r.id,
        kind: r.kind,
        payload: parsed,
        created_at: r.createdAt instanceof Date ? Math.floor(r.createdAt.getTime() / 1000) : null,
      };
    })
    .sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
}

function formatShow(payload: ShowPayload): string {
  const a = payload.approval;
  const lines: string[] = [];
  lines.push(`id: ${a.id}`);
  lines.push(`status: ${a.status}`);
  lines.push(`run_id: ${a.runId ?? '—'}`);
  lines.push(`step_id: ${a.stepId ?? '—'}`);
  lines.push(`action: ${a.action}`);
  if (a.revisedAction) lines.push(`revised_action: ${a.revisedAction}`);
  lines.push(`requested_by: ${a.requestedBy}`);
  lines.push(`requested_at: ${isoSecondsToShort(a.requestedAt)}`);
  lines.push(`expires_at: ${isoSecondsToShort(a.expiresAt)}`);
  lines.push(`decided_by: ${a.decidedBy ?? '—'}`);
  lines.push(`decided_at: ${isoSecondsToShort(a.decidedAt)}`);
  if (a.reason) lines.push(`reason: ${a.reason}`);
  if (a.note) lines.push(`note: ${a.note}`);

  lines.push('');
  if (payload.events.length === 0) {
    lines.push('events: (none)');
  } else {
    lines.push('events:');
    const rows = payload.events.map((e) => [e.id, e.kind, isoSecondsToShort(e.created_at)]);
    lines.push(formatTable(['ID', 'KIND', 'CREATED_AT'], rows).trimEnd());
  }
  return lines.join('\n') + '\n';
}

async function runShow(cwd: string, id: string, opts: ShowCliOptions): Promise<void> {
  const workspace = resolveWorkspaceRoot(cwd);
  const db = await openWorkspaceDb(workspace);
  try {
    const approval = await getRequest(id, { db });
    if (!approval) {
      process.stderr.write(`Approval not found: ${id}\n`);
      process.exit(1);
    }
    const related = await fetchRelatedEvents(db, id);
    const payload: ShowPayload = { approval, events: related };

    if (opts.json) {
      process.stdout.write(JSON.stringify(payload) + '\n');
      return;
    }
    process.stdout.write(formatShow(payload));
  } finally {
    db.$sqlite.close();
  }
}

// ---------------------------------------------------------------------------
// `approvals approve|reject|revise`
// ---------------------------------------------------------------------------

interface DecideCliOptions {
  note?: string;
  json?: boolean;
}

interface ReviseCliOptions extends DecideCliOptions {
  action?: string;
}

async function runApprove(cwd: string, id: string, opts: DecideCliOptions): Promise<void> {
  const workspace = resolveWorkspaceRoot(cwd);
  const db = await openWorkspaceDb(workspace);
  try {
    // TODO(phase-12): replace 'cli-user' with the resolved identity.
    const result = await decideRequest({
      db,
      approvalId: id,
      verdict: 'approve',
      decidedBy: 'cli-user',
      ...(opts.note !== undefined ? { note: opts.note } : {}),
    });
    if (opts.json) {
      process.stdout.write(JSON.stringify(result) + '\n');
      return;
    }
    process.stdout.write(`approved: ${id}\n`);
  } finally {
    db.$sqlite.close();
  }
}

async function runReject(cwd: string, id: string, opts: DecideCliOptions): Promise<void> {
  const workspace = resolveWorkspaceRoot(cwd);
  const db = await openWorkspaceDb(workspace);
  try {
    // TODO(phase-12): replace 'cli-user' with the resolved identity.
    const result = await decideRequest({
      db,
      approvalId: id,
      verdict: 'reject',
      decidedBy: 'cli-user',
      ...(opts.note !== undefined ? { note: opts.note } : {}),
    });
    if (opts.json) {
      process.stdout.write(JSON.stringify(result) + '\n');
      return;
    }
    process.stdout.write(`rejected: ${id}\n`);
  } finally {
    db.$sqlite.close();
  }
}

async function runRevise(cwd: string, id: string, opts: ReviseCliOptions): Promise<void> {
  if (!opts.action || opts.action.length === 0) {
    throw new Error('--action is required for revise');
  }
  const workspace = resolveWorkspaceRoot(cwd);
  const db = await openWorkspaceDb(workspace);
  try {
    // TODO(phase-12): replace 'cli-user' with the resolved identity.
    const result = await decideRequest({
      db,
      approvalId: id,
      verdict: 'revise',
      decidedBy: 'cli-user',
      revisedAction: opts.action,
      ...(opts.note !== undefined ? { note: opts.note } : {}),
    });
    if (opts.json) {
      process.stdout.write(JSON.stringify(result) + '\n');
      return;
    }
    process.stdout.write(`revised: ${id}\n`);
  } finally {
    db.$sqlite.close();
  }
}

// ---------------------------------------------------------------------------
// Command wiring
// ---------------------------------------------------------------------------

function withErrorReporting(fn: () => Promise<void>, label: string): () => Promise<void> {
  return async () => {
    try {
      await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`agent-os ${label}: ${message}\n`);
      process.exit(1);
    }
  };
}

export function buildApprovalsCommand(): Command {
  const cmd = new Command('approvals').description('Inspect and decide pending approval requests');

  cmd
    .command('list')
    .description('List approval requests in the queue')
    .option('--all', 'Include expired rows in the listing', false)
    .option('--json', 'Emit a machine-readable JSON array', false)
    .action((options: ListCliOptions) =>
      withErrorReporting(() => runList(process.cwd(), options), 'approvals list')(),
    );

  cmd
    .command('show <id>')
    .description('Show a single approval row and its related events')
    .option('--json', 'Emit a machine-readable JSON payload', false)
    .action((id: string, options: ShowCliOptions) =>
      withErrorReporting(() => runShow(process.cwd(), id, options), 'approvals show')(),
    );

  cmd
    .command('approve <id>')
    .description('Approve a pending approval request')
    .option('--note <text>', 'Reviewer note attached to the decision')
    .option('--json', 'Emit the updated row as JSON', false)
    .action((id: string, options: DecideCliOptions) =>
      withErrorReporting(() => runApprove(process.cwd(), id, options), 'approvals approve')(),
    );

  cmd
    .command('reject <id>')
    .description('Reject a pending approval request')
    .option('--note <text>', 'Reviewer note attached to the decision')
    .option('--json', 'Emit the updated row as JSON', false)
    .action((id: string, options: DecideCliOptions) =>
      withErrorReporting(() => runReject(process.cwd(), id, options), 'approvals reject')(),
    );

  cmd
    .command('revise <id>')
    .description('Revise a pending approval (keeps it pending with a new action)')
    .requiredOption('--action <new-action>', 'Replacement action string')
    .option('--note <text>', 'Reviewer note attached to the decision')
    .option('--json', 'Emit the updated row as JSON', false)
    .action((id: string, options: ReviseCliOptions) =>
      withErrorReporting(() => runRevise(process.cwd(), id, options), 'approvals revise')(),
    );

  return cmd;
}
