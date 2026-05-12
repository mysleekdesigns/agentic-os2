import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { createBlobStore, type BlobStore } from '../../../src/storage/blobs.js';
import { openDatabase, type AgentOsDb } from '../../../src/storage/db.js';
import { runMigrations } from '../../../src/storage/migrate.js';
import { runs, steps, toolCalls } from '../../../src/storage/schema.js';
import { createSqliteAuditor, redactSecrets } from '../../../src/core/tools/audit.js';

let db: AgentOsDb;
let blobs: BlobStore;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'agent-os-audit-'));
  db = openDatabase(':memory:', { noWal: true });
  await runMigrations(db, { log: () => undefined });
  blobs = createBlobStore({ root: join(tmpDir, 'blobs') });
});

afterEach(() => {
  db.$sqlite.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('createSqliteAuditor', () => {
  it('writes one runs row and one steps row eagerly', async () => {
    const auditor = await createSqliteAuditor({
      db,
      blobs,
      agentId: 'agent-1',
      provider: 'claude_code_local',
      model: 'opus',
    });

    const runRows = await db.select().from(runs).where(eq(runs.id, auditor.runId));
    expect(runRows).toHaveLength(1);
    expect(runRows[0]?.status).toBe('running');
    expect(runRows[0]?.provider).toBe('claude_code_local');

    const stepRows = await db.select().from(steps).where(eq(steps.id, auditor.stepId));
    expect(stepRows).toHaveLength(1);
    expect(stepRows[0]?.kind).toBe('tool_call');
    expect(stepRows[0]?.status).toBe('running');
  });

  it('uses the override runId when supplied', async () => {
    const auditor = await createSqliteAuditor({
      db,
      blobs,
      agentId: 'agent-1',
      runId: 'fixed-run-id',
      provider: 'p',
      model: 'm',
    });
    expect(auditor.runId).toBe('fixed-run-id');
  });
});

describe('onCall', () => {
  it('writes a tool_calls row with status=approved and a valid args_ref hex', async () => {
    const auditor = await createSqliteAuditor({
      db,
      blobs,
      agentId: 'agent-1',
      provider: 'p',
      model: 'm',
    });
    await auditor.onCall({
      toolCallId: 'tc_1',
      tool: 'fs.read',
      args: { path: '/etc/hosts' },
      risk: 'read',
      decision: 'allow',
      rule: 'agent_allow',
      reason: 'ok',
      decidedBy: 'policy',
    });

    const rows = await db.select().from(toolCalls).where(eq(toolCalls.stepId, auditor.stepId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tool).toBe('fs.read');
    expect(rows[0]?.risk).toBe('read');
    expect(rows[0]?.status).toBe('approved');
    expect(rows[0]?.approvedBy).toBe('policy');
    expect(rows[0]?.argsRef).toMatch(/^[a-f0-9]{64}$/);
    expect(await blobs.has(rows[0]!.argsRef!)).toBe(true);
  });

  it('writes status=rejected for decision=deny', async () => {
    const auditor = await createSqliteAuditor({
      db,
      blobs,
      agentId: 'agent-1',
      provider: 'p',
      model: 'm',
    });
    await auditor.onCall({
      toolCallId: 'tc_1',
      tool: 'fs.rm',
      args: { path: '/' },
      risk: 'destructive',
      decision: 'deny',
      rule: 'risk_levels',
      reason: 'denied',
      decidedBy: 'policy',
    });

    const rows = await db.select().from(toolCalls).where(eq(toolCalls.stepId, auditor.stepId));
    expect(rows[0]?.status).toBe('rejected');
  });
});

describe('onResult', () => {
  it('updates the row with latency_ms, result_ref, and status=succeeded', async () => {
    const auditor = await createSqliteAuditor({
      db,
      blobs,
      agentId: 'agent-1',
      provider: 'p',
      model: 'm',
    });
    await auditor.onCall({
      toolCallId: 'tc_1',
      tool: 'fs.read',
      args: { path: '/x' },
      risk: 'read',
      decision: 'allow',
      rule: 'agent_allow',
      reason: 'ok',
      decidedBy: 'policy',
    });
    await auditor.onResult({
      toolCallId: 'tc_1',
      result: { bytes: 42 },
      latencyMs: 17,
    });

    const rows = await db.select().from(toolCalls).where(eq(toolCalls.stepId, auditor.stepId));
    expect(rows[0]?.latencyMs).toBe(17);
    expect(rows[0]?.status).toBe('succeeded');
    expect(rows[0]?.resultRef).toMatch(/^[a-f0-9]{64}$/);
    expect(await blobs.has(rows[0]!.resultRef!)).toBe(true);
  });

  it('flips status to failed on isError=true', async () => {
    const auditor = await createSqliteAuditor({
      db,
      blobs,
      agentId: 'agent-1',
      provider: 'p',
      model: 'm',
    });
    await auditor.onCall({
      toolCallId: 'tc_1',
      tool: 'fs.read',
      args: {},
      risk: 'read',
      decision: 'allow',
      rule: 'agent_allow',
      reason: 'ok',
      decidedBy: 'policy',
    });
    await auditor.onResult({
      toolCallId: 'tc_1',
      result: 'oops',
      isError: true,
      latencyMs: 3,
    });

    const rows = await db.select().from(toolCalls).where(eq(toolCalls.stepId, auditor.stepId));
    expect(rows[0]?.status).toBe('failed');
  });

  it('is a no-op for unknown tool call ids', async () => {
    const auditor = await createSqliteAuditor({
      db,
      blobs,
      agentId: 'agent-1',
      provider: 'p',
      model: 'm',
    });
    await auditor.onResult({ toolCallId: 'never_called', latencyMs: 0 });
    const rows = await db.select().from(toolCalls).where(eq(toolCalls.stepId, auditor.stepId));
    expect(rows).toHaveLength(0);
  });
});

describe('finalize', () => {
  it('sets runs.status=failed and ended_at on error', async () => {
    const auditor = await createSqliteAuditor({
      db,
      blobs,
      agentId: 'agent-1',
      provider: 'p',
      model: 'm',
    });
    await auditor.finalize('error');
    const runRows = await db.select().from(runs).where(eq(runs.id, auditor.runId));
    expect(runRows[0]?.status).toBe('failed');
    expect(runRows[0]?.endedAt).not.toBeNull();
  });

  it('sets runs.status=succeeded on completed', async () => {
    const auditor = await createSqliteAuditor({
      db,
      blobs,
      agentId: 'agent-1',
      provider: 'p',
      model: 'm',
    });
    await auditor.finalize('completed');
    const runRows = await db.select().from(runs).where(eq(runs.id, auditor.runId));
    expect(runRows[0]?.status).toBe('succeeded');
  });

  it('sets runs.status=cancelled on cancellation', async () => {
    const auditor = await createSqliteAuditor({
      db,
      blobs,
      agentId: 'agent-1',
      provider: 'p',
      model: 'm',
    });
    await auditor.finalize('cancelled');
    const runRows = await db.select().from(runs).where(eq(runs.id, auditor.runId));
    expect(runRows[0]?.status).toBe('cancelled');
  });
});

describe('redactSecrets', () => {
  it('replaces values of secret-named keys with <redacted>', () => {
    const out = redactSecrets({
      api_key: 'sk-real-key-value',
      Authorization: 'Bearer abcdef0123456789xyz',
      password: 'hunter2',
      access_token: 'tok_real',
      nested: { secret: 's', innocent: 1 },
    }) as Record<string, unknown>;
    expect(out.api_key).toBe('<redacted>');
    expect(out.Authorization).toBe('<redacted>');
    expect(out.password).toBe('<redacted>');
    expect(out.access_token).toBe('<redacted>');
    expect((out.nested as Record<string, unknown>).secret).toBe('<redacted>');
    expect((out.nested as Record<string, unknown>).innocent).toBe(1);
  });

  it('redacts vendor key patterns inside arbitrary string values', () => {
    expect(redactSecrets('Authorization: Bearer abcdef0123456789ZZZZ')).toMatch(/<redacted>/);
    expect(redactSecrets('use sk-AAAABBBBCCCCDDDDEEEE for now')).toMatch(/<redacted>/);
    expect(redactSecrets('google key AIzaSyDxxxxxxxxxxxxxxxxxxxxxxxxxxxxx leaked')).toMatch(
      /<redacted>/,
    );
    expect(redactSecrets('use ghp_AAAABBBBCCCCDDDDEEEEFFFF for github')).toMatch(/<redacted>/);
  });

  it('passes through values that look nothing like secrets', () => {
    expect(redactSecrets('hello world')).toBe('hello world');
    expect(redactSecrets({ foo: 1, bar: [1, 2, 3] })).toEqual({ foo: 1, bar: [1, 2, 3] });
    expect(redactSecrets(null)).toBe(null);
    expect(redactSecrets(undefined)).toBe(undefined);
  });

  it('audit log honours redactSecrets:true by default', async () => {
    const auditor = await createSqliteAuditor({
      db,
      blobs,
      agentId: 'agent-1',
      provider: 'p',
      model: 'm',
    });
    await auditor.onCall({
      toolCallId: 'tc1',
      tool: 'Edit',
      args: { api_key: 'sk-real-key-please-hide-me', other: 'public' },
      risk: 'write',
      decision: 'allow',
      rule: 'agent_allow',
      reason: 'allowed',
      decidedBy: 'policy',
    });
    const rows = await db.select().from(toolCalls);
    const argsRef = rows[0]?.argsRef;
    expect(argsRef).toBeTruthy();
    const stored = (await blobs.read(argsRef as string)).toString('utf8');
    expect(stored).not.toContain('sk-real-key');
    expect(stored).toContain('<redacted>');
    expect(stored).toContain('public');
  });

  it('audit log persists raw values when redactSecrets:false', async () => {
    const auditor = await createSqliteAuditor({
      db,
      blobs,
      agentId: 'agent-1',
      provider: 'p',
      model: 'm',
      redactSecrets: false,
    });
    await auditor.onCall({
      toolCallId: 'tc1',
      tool: 'Edit',
      args: { api_key: 'sk-real-key-please-keep-me', other: 'public' },
      risk: 'write',
      decision: 'allow',
      rule: 'agent_allow',
      reason: 'allowed',
      decidedBy: 'policy',
    });
    const rows = await db.select().from(toolCalls);
    const argsRef = rows[0]?.argsRef;
    const stored = (await blobs.read(argsRef as string)).toString('utf8');
    expect(stored).toContain('sk-real-key-please-keep-me');
  });
});
