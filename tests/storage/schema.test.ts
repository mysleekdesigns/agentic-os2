import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type AgentOsDb } from '../../src/storage/db.js';
import { runMigrations } from '../../src/storage/migrate.js';
import {
  agents,
  runs,
  steps,
  toolCalls,
  approvals,
  memory,
  events,
} from '../../src/storage/schema.js';
import { eq } from 'drizzle-orm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MIGRATIONS_DIR = resolve(__dirname, '..', '..', 'drizzle', 'migrations');

describe('storage schema migrations', () => {
  let db: AgentOsDb;

  beforeEach(async () => {
    db = openDatabase(':memory:');
    await runMigrations(db, {
      migrationsDir: MIGRATIONS_DIR,
      log: () => {},
    });
  });

  afterEach(() => {
    db.$sqlite.close();
  });

  it('records applied migrations in the bookkeeping table', () => {
    const rows = db.$sqlite
      .prepare('SELECT name, status FROM _agent_os_migrations ORDER BY name')
      .all() as Array<{ name: string; status: string }>;
    const byName = Object.fromEntries(rows.map((r) => [r.name, r.status]));
    expect(byName['0001_init']).toMatch(/^applied/);
    // 0002 is either applied (if sqlite-vec loaded) or skipped (otherwise).
    expect(byName['0002_embeddings_vec']).toBeDefined();
  });

  it('round-trips an agent → run → step → tool_call → approval', async () => {
    const now = new Date();

    await db.insert(agents).values({
      id: 'a1',
      version: '1',
      definitionPath: 'agents/a1.md',
      hash: 'deadbeef',
      createdAt: now,
    });

    await db.insert(runs).values({
      id: 'r1',
      agentId: 'a1',
      status: 'running',
      startedAt: now,
      provider: 'claude_code_local',
      model: 'opus',
    });

    await db.insert(steps).values({
      id: 's1',
      runId: 'r1',
      kind: 'tool_call',
      name: 'fetch_url',
      status: 'pending',
      startedAt: now,
    });

    await db.insert(toolCalls).values({
      id: 't1',
      stepId: 's1',
      tool: 'mcp.crawlforge.fetch_url',
      risk: 'network',
      status: 'pending',
    });

    await db.insert(approvals).values({
      id: 'ap1',
      stepId: 's1',
      requestedBy: 'agent:a1',
      action: 'fetch_url',
      status: 'pending',
    });

    const fetchedAgent = await db.select().from(agents).where(eq(agents.id, 'a1'));
    expect(fetchedAgent).toHaveLength(1);
    expect(fetchedAgent[0]?.hash).toBe('deadbeef');

    const fetchedRun = await db.select().from(runs).where(eq(runs.id, 'r1'));
    expect(fetchedRun[0]?.status).toBe('running');
    expect(fetchedRun[0]?.provider).toBe('claude_code_local');

    const fetchedStep = await db.select().from(steps).where(eq(steps.id, 's1'));
    expect(fetchedStep[0]?.kind).toBe('tool_call');

    const fetchedTool = await db.select().from(toolCalls).where(eq(toolCalls.id, 't1'));
    expect(fetchedTool[0]?.risk).toBe('network');

    const fetchedApproval = await db.select().from(approvals).where(eq(approvals.id, 'ap1'));
    expect(fetchedApproval[0]?.status).toBe('pending');
  });

  it('round-trips memory and events rows', async () => {
    const now = new Date();

    await db.insert(memory).values({
      id: 'm1',
      scope: 'agent',
      key: 'notes',
      valueRef: 'a'.repeat(64),
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(events).values({
      id: 'e1',
      kind: 'audit.tool_call',
      payload: JSON.stringify({ tool: 'fs.read' }),
      createdAt: now,
    });

    const fetchedMem = await db.select().from(memory).where(eq(memory.id, 'm1'));
    expect(fetchedMem[0]?.scope).toBe('agent');
    expect(fetchedMem[0]?.valueRef).toBe('a'.repeat(64));

    const fetchedEvt = await db.select().from(events).where(eq(events.id, 'e1'));
    expect(fetchedEvt[0]?.kind).toBe('audit.tool_call');
  });

  it('enforces CHECK constraints on status enums', () => {
    expect(() =>
      db.$sqlite
        .prepare(
          `INSERT INTO runs (id, agent_id, status, started_at, provider, model)
           VALUES ('bad', 'a1', 'not_a_status', 0, 'p', 'm')`,
        )
        .run(),
    ).toThrow();
  });

  it('is idempotent: re-running migrations does not error', async () => {
    const outcomes = await runMigrations(db, {
      migrationsDir: MIGRATIONS_DIR,
      log: () => {},
    });
    expect(outcomes.length).toBeGreaterThanOrEqual(1);
    for (const o of outcomes) {
      expect(['applied', 'already-applied', 'skipped']).toContain(o.status);
    }
  });
});
