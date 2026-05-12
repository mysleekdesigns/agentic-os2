/**
 * Approval queue (PRD §3 Phase 6).
 *
 * Pure functions over a Drizzle `AgentOsDb` handle. No CLI or executor
 * dependencies — those layers consume this module.
 *
 * Semantics
 * ---------
 * TTL:
 *   - `requestedAt` is the (unix epoch seconds) timestamp of the request.
 *   - `expiresAt = requestedAt + ttlSeconds` when a TTL is configured, else
 *     null. `null` means the approval never expires.
 *   - Expiration is LAZY + ON-READ: `listRequests` filters effectively-expired
 *     pending rows from the default view, but only `expireDueRequests` (or
 *     `gcExpiredOlderThan`) actually mutate rows to `status='expired'`.
 *
 * Revise:
 *   - `decideRequest({verdict:'revise'})` keeps `status='pending'`. It writes
 *     `revisedAction`, `note`, `decidedBy`, `decidedAt` so a subsequent
 *     approve/reject can act on the revised action. There is NO `revised`
 *     status — the CHECK constraint on `status` remains the original four
 *     (pending/approved/rejected/expired).
 *
 * Event log shape:
 *   - Every state transition emits a row in `events` with:
 *       kind     ∈ { 'approval.requested', 'approval.approved',
 *                   'approval.rejected', 'approval.revised',
 *                   'approval.expired' }
 *       payload  JSON: { approval_id, run_id, step_id, who, when, why,
 *                       action, revised_action? }
 *     The `who` field is `requested_by` for `approval.requested` and
 *     `decided_by` for the four decision kinds.
 *
 * Time model:
 *   - The Drizzle schema stores both `requestedAt` and `expiresAt` as
 *     `integer({ mode: 'timestamp' })`, which means Drizzle converts to/from
 *     `Date` at the row boundary. The public API of this module talks in
 *     unix-epoch SECONDS (numbers) to keep tests deterministic and to match
 *     the schema's underlying storage unit.
 */

import { and, eq, isNotNull, lte } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { approvals, events } from '../../storage/schema.js';
import type { AgentOsDb } from '../../storage/db.js';
import type {
  ApprovalRequest,
  ApprovalStatus,
  CreateRequestInput,
  DecisionInput,
} from './types.js';

export type Clock = () => number; // unix epoch seconds

const defaultClock: Clock = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------
// Row mapping helpers
// ---------------------------------------------------------------------------

interface ApprovalRow {
  id: string;
  runId: string | null;
  stepId: string | null;
  requestedBy: string;
  action: string;
  status: ApprovalStatus;
  requestedAt: Date | null;
  expiresAt: Date | null;
  decidedBy: string | null;
  decidedAt: Date | null;
  reason: string | null;
  note: string | null;
  revisedAction: string | null;
}

function dateToSeconds(d: Date | null | undefined): number | null {
  if (!d) return null;
  return Math.floor(d.getTime() / 1000);
}

function secondsToDate(s: number): Date {
  return new Date(s * 1000);
}

function rowToRequest(row: ApprovalRow): ApprovalRequest {
  return {
    id: row.id,
    runId: row.runId,
    stepId: row.stepId,
    requestedBy: row.requestedBy,
    action: row.action,
    reason: row.reason,
    requestedAt: dateToSeconds(row.requestedAt) ?? 0,
    expiresAt: dateToSeconds(row.expiresAt),
    note: row.note,
    revisedAction: row.revisedAction,
    status: row.status,
    decidedBy: row.decidedBy,
    decidedAt: dateToSeconds(row.decidedAt),
  };
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
// Public API
// ---------------------------------------------------------------------------

export interface CreateRequestArgs extends CreateRequestInput {
  db: AgentOsDb;
  clock?: Clock;
  /** Used when `ttlSeconds` is absent. Pass from `loadApprovalPolicies`. */
  defaultTtlSeconds?: number | null;
}

/**
 * Create a new pending approval request. Inserts the row and emits an
 * `approval.requested` event. Returns the persisted row.
 */
export async function createRequest(args: CreateRequestArgs): Promise<ApprovalRequest> {
  const clock = args.clock ?? defaultClock;
  const id = args.id ?? randomUUID();
  const requestedAt = args.at ?? clock();

  // ttlSeconds: null = explicit no-expiry; undefined = fall back to default.
  const ttl: number | null =
    args.ttlSeconds === null
      ? null
      : args.ttlSeconds !== undefined
        ? args.ttlSeconds
        : (args.defaultTtlSeconds ?? null);
  const expiresAt: number | null = ttl !== null ? requestedAt + ttl : null;

  await args.db.insert(approvals).values({
    id,
    runId: args.runId ?? null,
    stepId: args.stepId ?? null,
    requestedBy: args.requestedBy,
    action: args.action,
    status: 'pending',
    requestedAt: secondsToDate(requestedAt),
    expiresAt: expiresAt !== null ? secondsToDate(expiresAt) : null,
    reason: args.reason ?? null,
  });

  await emitEvent(
    args.db,
    'approval.requested',
    {
      approval_id: id,
      run_id: args.runId ?? null,
      step_id: args.stepId ?? null,
      who: args.requestedBy,
      when: requestedAt,
      why: args.reason ?? null,
      action: args.action,
      expires_at: expiresAt,
    },
    requestedAt,
  );

  const persisted = await loadRow(args.db, id);
  if (!persisted) {
    throw new Error(`createRequest: failed to read back approval id=${id}`);
  }
  return persisted;
}

export interface GetRequestArgs {
  db: AgentOsDb;
}

export async function getRequest(
  id: string,
  { db }: GetRequestArgs,
): Promise<ApprovalRequest | null> {
  return loadRow(db, id);
}

export interface ListRequestsArgs {
  db: AgentOsDb;
  status?: ApprovalStatus;
  runId?: string;
  /**
   * When false (default), pending rows whose `expires_at <= now()` are hidden
   * from the result (they're effectively expired). Set true to see everything.
   * Note: this does NOT mutate rows — see `expireDueRequests`.
   */
  includeExpired?: boolean;
  clock?: Clock;
}

/**
 * List approval requests, sorted by `requested_at DESC`. Filters
 * effectively-expired pending rows unless `includeExpired=true`.
 */
export async function listRequests(opts: ListRequestsArgs): Promise<ApprovalRequest[]> {
  const clock = opts.clock ?? defaultClock;
  const rows = (await opts.db.select().from(approvals)) as ApprovalRow[];
  const now = clock();

  let filtered = rows;
  if (opts.status) {
    filtered = filtered.filter((r) => r.status === opts.status);
  }
  if (opts.runId !== undefined) {
    filtered = filtered.filter((r) => r.runId === opts.runId);
  }
  if (!opts.includeExpired) {
    filtered = filtered.filter((r) => {
      if (r.status !== 'pending') return true;
      const exp = dateToSeconds(r.expiresAt);
      if (exp === null) return true;
      return exp > now;
    });
  }

  filtered.sort((a, b) => {
    const aTs = dateToSeconds(a.requestedAt) ?? 0;
    const bTs = dateToSeconds(b.requestedAt) ?? 0;
    return bTs - aTs;
  });

  return filtered.map(rowToRequest);
}

export interface DecideRequestArgs extends DecisionInput {
  db: AgentOsDb;
  clock?: Clock;
}

/**
 * Apply a decision to a pending approval. Throws if the row is missing or not
 * pending. For `approve`/`reject`, transitions status; for `revise`, keeps
 * the row pending and stores the revised action + note.
 */
export async function decideRequest(args: DecideRequestArgs): Promise<ApprovalRequest> {
  const clock = args.clock ?? defaultClock;
  const at = args.at ?? clock();

  const row = await loadRow(args.db, args.approvalId);
  if (!row) {
    throw new Error(`decideRequest: approval id=${args.approvalId} not found`);
  }
  if (row.status !== 'pending') {
    throw new Error(
      `decideRequest: approval id=${args.approvalId} is terminal (status=${row.status})`,
    );
  }

  if (args.verdict === 'revise') {
    if (!args.revisedAction || args.revisedAction.length === 0) {
      throw new Error('decideRequest: revisedAction is required when verdict="revise"');
    }
    await args.db
      .update(approvals)
      .set({
        revisedAction: args.revisedAction,
        note: args.note ?? null,
        decidedBy: args.decidedBy,
        decidedAt: secondsToDate(at),
        // Crucially: status stays 'pending'.
        action: args.revisedAction,
      })
      .where(eq(approvals.id, args.approvalId));

    await emitEvent(
      args.db,
      'approval.revised',
      {
        approval_id: args.approvalId,
        run_id: row.runId,
        step_id: row.stepId,
        who: args.decidedBy,
        when: at,
        why: args.note ?? null,
        action: row.action,
        revised_action: args.revisedAction,
      },
      at,
    );
  } else {
    const newStatus: ApprovalStatus = args.verdict === 'approve' ? 'approved' : 'rejected';
    await args.db
      .update(approvals)
      .set({
        status: newStatus,
        decidedBy: args.decidedBy,
        decidedAt: secondsToDate(at),
        note: args.note ?? null,
      })
      .where(eq(approvals.id, args.approvalId));

    await emitEvent(
      args.db,
      args.verdict === 'approve' ? 'approval.approved' : 'approval.rejected',
      {
        approval_id: args.approvalId,
        run_id: row.runId,
        step_id: row.stepId,
        who: args.decidedBy,
        when: at,
        why: args.note ?? null,
        action: row.revisedAction ?? row.action,
      },
      at,
    );
  }

  const updated = await loadRow(args.db, args.approvalId);
  if (!updated) {
    throw new Error(`decideRequest: approval id=${args.approvalId} vanished after update`);
  }
  return updated;
}

export interface ExpireDueRequestsArgs {
  db: AgentOsDb;
  clock?: Clock;
}

/**
 * Transition every pending row whose `expires_at <= clock()` to
 * `status='expired'`. Emits an `approval.expired` event per row. Idempotent.
 */
export async function expireDueRequests(args: ExpireDueRequestsArgs): Promise<ApprovalRequest[]> {
  const clock = args.clock ?? defaultClock;
  const now = clock();
  const nowDate = secondsToDate(now);

  // Drizzle compares timestamp columns against Date objects.
  const rows = (await args.db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.status, 'pending'),
        isNotNull(approvals.expiresAt),
        lte(approvals.expiresAt, nowDate),
      ),
    )) as ApprovalRow[];

  const transitioned: ApprovalRequest[] = [];
  for (const row of rows) {
    await args.db
      .update(approvals)
      .set({ status: 'expired', decidedAt: nowDate, decidedBy: row.decidedBy ?? 'system' })
      .where(eq(approvals.id, row.id));

    await emitEvent(
      args.db,
      'approval.expired',
      {
        approval_id: row.id,
        run_id: row.runId,
        step_id: row.stepId,
        who: 'system',
        when: now,
        why: 'ttl_elapsed',
        action: row.revisedAction ?? row.action,
        expires_at: dateToSeconds(row.expiresAt),
      },
      now,
    );

    const fresh = await loadRow(args.db, row.id);
    if (fresh) transitioned.push(fresh);
  }
  return transitioned;
}

export interface GcExpiredArgs {
  db: AgentOsDb;
  olderThanSeconds: number;
  clock?: Clock;
}

/**
 * Delete `status='expired'` rows whose `decided_at < clock() - olderThanSeconds`.
 * Returns the count deleted.
 */
export async function gcExpiredOlderThan(args: GcExpiredArgs): Promise<number> {
  const clock = args.clock ?? defaultClock;
  const cutoff = clock() - args.olderThanSeconds;
  const cutoffDate = secondsToDate(cutoff);

  // Drizzle's better-sqlite3 driver returns a result with `changes` via the
  // underlying statement. We use raw SQL via `db.run` for a portable rowcount.
  const result = args.db.$sqlite
    .prepare(
      `DELETE FROM approvals WHERE status = 'expired' AND decided_at IS NOT NULL AND decided_at < ?`,
    )
    .run(Math.floor(cutoffDate.getTime() / 1000));

  return result.changes;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function loadRow(db: AgentOsDb, id: string): Promise<ApprovalRequest | null> {
  const rows = (await db.select().from(approvals).where(eq(approvals.id, id))) as ApprovalRow[];
  if (rows.length === 0) return null;
  return rowToRequest(rows[0]!);
}

// ---------------------------------------------------------------------------
// Barrel re-exports
// ---------------------------------------------------------------------------

export type {
  ApprovalRequest,
  ApprovalStatus,
  CreateRequestInput,
  DecisionInput,
  DecisionVerdict,
} from './types.js';

export {
  loadApprovalPolicies,
  resolveTtlSeconds,
  requiresApprovalByPolicy,
  evaluateWithApprovalPolicies,
} from './policies.js';
export type { ApprovalPolicies, AgentPolicy, ToolPolicy, WorkflowPolicy } from './policies.js';
