/**
 * Approval queue tests (PRD §3 Phase 6).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { openDatabase, type AgentOsDb } from '../../../src/storage/db.js';
import { runMigrations } from '../../../src/storage/migrate.js';
import { events } from '../../../src/storage/schema.js';
import {
  createRequest,
  decideRequest,
  expireDueRequests,
  gcExpiredOlderThan,
  getRequest,
  listRequests,
} from '../../../src/core/approvals/index.js';

describe('approvals queue', () => {
  let db: AgentOsDb;
  let now = 1_000_000;
  const clock = (): number => now;

  beforeEach(async () => {
    db = openDatabase(':memory:');
    await runMigrations(db, { log: () => undefined });
    now = 1_000_000;
  });

  afterEach(() => {
    db.$sqlite.close();
  });

  it('creates a request with TTL, emits approval.requested, and reads it back', async () => {
    const req = await createRequest({
      db,
      clock,
      requestedBy: 'agent:a1',
      action: 'fs.write',
      reason: 'wants to write file',
      ttlSeconds: 60,
      id: 'ap1',
    });
    expect(req.id).toBe('ap1');
    expect(req.status).toBe('pending');
    expect(req.requestedAt).toBe(1_000_000);
    expect(req.expiresAt).toBe(1_000_060);
    expect(req.note).toBeNull();
    expect(req.revisedAction).toBeNull();

    const fetched = await getRequest('ap1', { db });
    expect(fetched?.action).toBe('fs.write');

    const evRows = await db.select().from(events).where(eq(events.kind, 'approval.requested'));
    expect(evRows).toHaveLength(1);
    const payload = JSON.parse(evRows[0]!.payload) as Record<string, unknown>;
    expect(payload.approval_id).toBe('ap1');
    expect(payload.who).toBe('agent:a1');
    expect(payload.expires_at).toBe(1_000_060);
  });

  it('falls back to defaultTtlSeconds when ttlSeconds is absent', async () => {
    const req = await createRequest({
      db,
      clock,
      requestedBy: 'agent:a1',
      action: 'fs.write',
      defaultTtlSeconds: 30,
      id: 'ap2',
    });
    expect(req.expiresAt).toBe(1_000_030);
  });

  it('honours explicit ttlSeconds=null (never expires)', async () => {
    const req = await createRequest({
      db,
      clock,
      requestedBy: 'agent:a1',
      action: 'fs.write',
      ttlSeconds: null,
      defaultTtlSeconds: 30,
      id: 'ap3',
    });
    expect(req.expiresAt).toBeNull();
  });

  it('approve transitions status and emits approval.approved', async () => {
    await createRequest({
      db,
      clock,
      requestedBy: 'agent:a1',
      action: 'fs.write',
      ttlSeconds: 60,
      id: 'ap1',
    });
    now = 1_000_010;
    const decided = await decideRequest({
      db,
      clock,
      approvalId: 'ap1',
      verdict: 'approve',
      decidedBy: 'cli-user',
      note: 'looks good',
    });
    expect(decided.status).toBe('approved');
    expect(decided.decidedBy).toBe('cli-user');
    expect(decided.decidedAt).toBe(1_000_010);
    expect(decided.note).toBe('looks good');

    const evs = await db.select().from(events).where(eq(events.kind, 'approval.approved'));
    expect(evs).toHaveLength(1);
  });

  it('reject transitions status and emits approval.rejected', async () => {
    await createRequest({
      db,
      clock,
      requestedBy: 'agent:a1',
      action: 'fs.write',
      ttlSeconds: 60,
      id: 'ap1',
    });
    const decided = await decideRequest({
      db,
      clock,
      approvalId: 'ap1',
      verdict: 'reject',
      decidedBy: 'cli-user',
      note: 'no thanks',
    });
    expect(decided.status).toBe('rejected');
    expect(decided.note).toBe('no thanks');
  });

  it('revise keeps status=pending and records the revised action', async () => {
    await createRequest({
      db,
      clock,
      requestedBy: 'agent:a1',
      action: 'fs.write:/etc/passwd',
      ttlSeconds: 60,
      id: 'ap1',
    });
    const revised = await decideRequest({
      db,
      clock,
      approvalId: 'ap1',
      verdict: 'revise',
      decidedBy: 'cli-user',
      revisedAction: 'fs.write:/tmp/output.txt',
      note: 'safer target',
    });
    expect(revised.status).toBe('pending');
    expect(revised.revisedAction).toBe('fs.write:/tmp/output.txt');
    expect(revised.action).toBe('fs.write:/tmp/output.txt');
    expect(revised.note).toBe('safer target');
    expect(revised.decidedBy).toBe('cli-user');

    // Now approve the revised request.
    const approved = await decideRequest({
      db,
      clock,
      approvalId: 'ap1',
      verdict: 'approve',
      decidedBy: 'cli-user',
    });
    expect(approved.status).toBe('approved');

    const evs = await db.select().from(events);
    const kinds = evs.map((e) => e.kind).sort();
    expect(kinds).toEqual(['approval.approved', 'approval.requested', 'approval.revised']);
  });

  it('revise without revisedAction throws', async () => {
    await createRequest({
      db,
      clock,
      requestedBy: 'a',
      action: 'fs.write',
      ttlSeconds: 60,
      id: 'ap1',
    });
    await expect(
      decideRequest({
        db,
        clock,
        approvalId: 'ap1',
        verdict: 'revise',
        decidedBy: 'cli-user',
      }),
    ).rejects.toThrow(/revisedAction is required/);
  });

  it('decideRequest throws on terminal rows', async () => {
    await createRequest({
      db,
      clock,
      requestedBy: 'a',
      action: 'fs.write',
      ttlSeconds: 60,
      id: 'ap1',
    });
    await decideRequest({
      db,
      clock,
      approvalId: 'ap1',
      verdict: 'approve',
      decidedBy: 'cli-user',
    });
    await expect(
      decideRequest({
        db,
        clock,
        approvalId: 'ap1',
        verdict: 'reject',
        decidedBy: 'cli-user',
      }),
    ).rejects.toThrow(/terminal/);
  });

  it('listRequests filters effectively-expired rows by default and sorts newest first', async () => {
    await createRequest({
      db,
      clock,
      requestedBy: 'a',
      action: 'fs.write',
      ttlSeconds: 10,
      id: 'ap1',
      at: 1_000_000,
    });
    await createRequest({
      db,
      clock,
      requestedBy: 'a',
      action: 'fs.read',
      ttlSeconds: 1000,
      id: 'ap2',
      at: 1_000_005,
    });
    now = 1_000_050; // ap1 effectively expired, ap2 still pending
    const visible = await listRequests({ db, clock });
    expect(visible.map((r) => r.id)).toEqual(['ap2']);

    const all = await listRequests({ db, clock, includeExpired: true });
    expect(all.map((r) => r.id)).toEqual(['ap2', 'ap1']);
  });

  it('expireDueRequests transitions due rows to expired and emits events', async () => {
    await createRequest({
      db,
      clock,
      requestedBy: 'a',
      action: 'fs.write',
      ttlSeconds: 10,
      id: 'ap1',
    });
    await createRequest({
      db,
      clock,
      requestedBy: 'a',
      action: 'fs.read',
      ttlSeconds: 1000,
      id: 'ap2',
    });
    now = 1_000_050;
    const expired = await expireDueRequests({ db, clock });
    expect(expired.map((r) => r.id)).toEqual(['ap1']);
    expect(expired[0]!.status).toBe('expired');

    // Running again is idempotent.
    const again = await expireDueRequests({ db, clock });
    expect(again).toHaveLength(0);

    const ev = await db.select().from(events).where(eq(events.kind, 'approval.expired'));
    expect(ev).toHaveLength(1);
  });

  it('gcExpiredOlderThan deletes only old expired rows', async () => {
    await createRequest({
      db,
      clock,
      requestedBy: 'a',
      action: 'fs.write',
      ttlSeconds: 10,
      id: 'ap1',
    });
    now = 1_000_050;
    await expireDueRequests({ db, clock });

    // Not old enough.
    now = 1_000_100;
    let count = await gcExpiredOlderThan({ db, clock, olderThanSeconds: 1000 });
    expect(count).toBe(0);

    // Old enough now.
    now = 1_010_000;
    count = await gcExpiredOlderThan({ db, clock, olderThanSeconds: 1000 });
    expect(count).toBe(1);

    expect(await getRequest('ap1', { db })).toBeNull();
  });
});
