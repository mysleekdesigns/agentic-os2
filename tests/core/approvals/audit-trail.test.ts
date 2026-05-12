/**
 * Audit-trail smoke check for the approvals queue (PRD §3 Phase 6).
 *
 * This test does NOT belong to the queue bundle proper — it's a defensive
 * fixture owned by the executor/interceptor bundle. Its job is to fail
 * loudly if the queue's `createRequest` / `decideRequest` audit-event shape
 * ever regresses, because the executor's "no polling" pause model relies on
 * `approval.requested` / `approval.approved` rows existing for every state
 * transition.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { openDatabase, type AgentOsDb } from '../../../src/storage/db.js';
import { runMigrations } from '../../../src/storage/migrate.js';
import { events } from '../../../src/storage/schema.js';
import { createRequest, decideRequest } from '../../../src/core/approvals/index.js';

describe('approvals queue — audit trail', () => {
  let db: AgentOsDb;
  let now = 2_000_000;
  const clock = (): number => now;

  beforeEach(async () => {
    db = openDatabase(':memory:');
    await runMigrations(db, { log: () => undefined });
    now = 2_000_000;
  });

  afterEach(() => {
    db.$sqlite.close();
  });

  it('emits exactly one events row for createRequest then one for decideRequest(approve)', async () => {
    await createRequest({
      db,
      clock,
      requestedBy: 'agent:a1',
      action: 'fs.write',
      reason: 'wants to write file',
      ttlSeconds: 60,
      id: 'ap-audit-1',
    });

    now = 2_000_010;
    await decideRequest({
      db,
      clock,
      approvalId: 'ap-audit-1',
      verdict: 'approve',
      decidedBy: 'user:test',
      note: 'looks fine',
    });

    const requestedRows = await db
      .select()
      .from(events)
      .where(eq(events.kind, 'approval.requested'));
    const decidedRows = await db.select().from(events).where(eq(events.kind, 'approval.approved'));

    expect(requestedRows).toHaveLength(1);
    expect(decidedRows).toHaveLength(1);

    const requestedPayload = JSON.parse(requestedRows[0]!.payload) as Record<string, unknown>;
    expect(requestedPayload.approval_id).toBe('ap-audit-1');
    expect(requestedPayload.who).toBe('agent:a1');
    expect(typeof requestedPayload.when).toBe('number');

    const decidedPayload = JSON.parse(decidedRows[0]!.payload) as Record<string, unknown>;
    expect(decidedPayload.approval_id).toBe('ap-audit-1');
    expect(decidedPayload.who).toBe('user:test');
    expect(decidedPayload.when).toBe(2_000_010);
    expect(decidedPayload.why).toBe('looks fine');
  });

  it('emits one approval.rejected row on decideRequest({verdict:"reject"})', async () => {
    await createRequest({
      db,
      clock,
      requestedBy: 'agent:a1',
      action: 'fs.write',
      ttlSeconds: 60,
      id: 'ap-audit-2',
    });
    now = 2_000_020;
    await decideRequest({
      db,
      clock,
      approvalId: 'ap-audit-2',
      verdict: 'reject',
      decidedBy: 'user:test',
      note: 'denied',
    });

    const rejected = await db.select().from(events).where(eq(events.kind, 'approval.rejected'));
    expect(rejected).toHaveLength(1);
    const payload = JSON.parse(rejected[0]!.payload) as Record<string, unknown>;
    expect(payload.who).toBe('user:test');
    expect(payload.when).toBe(2_000_020);
    expect(payload.approval_id).toBe('ap-audit-2');
  });
});
