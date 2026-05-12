/**
 * CLI tests for `agent-os logs` (PRD §3 Phase 8).
 *
 * The `logs` command tails the workspace `events` table in reverse-
 * chronological order, with filters by `kind`, `agent`, `since`, and
 * `limit`. We seed several `events` rows of different kinds and timestamps,
 * then drive the command via Commander exactly like `show.test.ts`.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildLogsCommand } from '../../src/cli/commands/logs.js';
import { runInit } from '../../src/cli/commands/init.js';
import { openDatabase, type AgentOsDb } from '../../src/storage/db.js';
import { runMigrations } from '../../src/storage/migrate.js';
import { agents, events, runs } from '../../src/storage/schema.js';

// ---------------------------------------------------------------------------
// CLI harness
// ---------------------------------------------------------------------------

async function runLogsCli(argv: readonly string[]): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
}> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  let exitCode: number | null = null;

  const writeStdout = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    });
  const writeStderr = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    });
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`__exit_${exitCode}__`);
  }) as (code?: number) => never);

  const program = new Command();
  program.exitOverride();
  program.addCommand(buildLogsCommand());

  try {
    await program.parseAsync(['node', 'agent-os', 'logs', ...argv]);
  } catch (err) {
    void err;
  } finally {
    writeStdout.mockRestore();
    writeStderr.mockRestore();
    exit.mockRestore();
  }

  return { stdout: stdoutChunks.join(''), stderr: stderrChunks.join(''), exitCode };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface SeedRow {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

async function seedEvents(db: AgentOsDb, rows: SeedRow[]): Promise<void> {
  for (const r of rows) {
    await db.insert(events).values({
      id: r.id,
      kind: r.kind,
      payload: JSON.stringify(r.payload),
      createdAt: r.createdAt,
    });
  }
}

interface LogsJsonRow {
  id: string;
  kind: string;
  created_at: number;
  payload: string;
}

function parseJsonl(stdout: string): LogsJsonRow[] {
  return stdout
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as LogsJsonRow);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('agent-os logs', () => {
  let tmpDir: string;
  let originalCwd: string;
  let dbPath: string;
  const now = 1_700_000_000_000;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agent-os-logs-'));
    runInit({ cwd: tmpDir });
    originalCwd = process.cwd();
    process.chdir(tmpDir);
    dbPath = join(tmpDir, '.agent-os', 'db.sqlite');

    const db = openDatabase(dbPath);
    try {
      await runMigrations(db, { log: () => undefined });
    } finally {
      db.$sqlite.close();
    }
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('--json returns all rows in reverse-chronological order', async () => {
    const db = openDatabase(dbPath);
    try {
      await seedEvents(db, [
        {
          id: 'e1',
          kind: 'approval.requested',
          payload: { action: 'fs.write' },
          createdAt: new Date(now - 60_000),
        },
        {
          id: 'e2',
          kind: 'approval.approved',
          payload: { action: 'fs.write' },
          createdAt: new Date(now - 30_000),
        },
        {
          id: 'e3',
          kind: 'memory.created',
          payload: { scope: 'project' },
          createdAt: new Date(now - 10_000),
        },
      ]);
    } finally {
      db.$sqlite.close();
    }

    const { stdout, exitCode } = await runLogsCli(['--json']);
    expect(exitCode === null || exitCode === 0).toBe(true);
    const rows = parseJsonl(stdout);
    expect(rows).toHaveLength(3);
    // Reverse-chronological → newest first.
    expect(rows[0]!.id).toBe('e3');
    expect(rows[1]!.id).toBe('e2');
    expect(rows[2]!.id).toBe('e1');
  });

  it('--kind filter narrows to the specified kinds (repeatable)', async () => {
    const db = openDatabase(dbPath);
    try {
      await seedEvents(db, [
        {
          id: 'a1',
          kind: 'approval.requested',
          payload: {},
          createdAt: new Date(now - 60_000),
        },
        {
          id: 'm1',
          kind: 'memory.denied',
          payload: {},
          createdAt: new Date(now - 40_000),
        },
        {
          id: 'm2',
          kind: 'memory.created',
          payload: {},
          createdAt: new Date(now - 20_000),
        },
        {
          id: 'a2',
          kind: 'approval.approved',
          payload: {},
          createdAt: new Date(now - 10_000),
        },
      ]);
    } finally {
      db.$sqlite.close();
    }

    const { stdout, exitCode } = await runLogsCli([
      '--kind',
      'approval.requested',
      '--kind',
      'memory.denied',
      '--json',
    ]);
    expect(exitCode === null || exitCode === 0).toBe(true);
    const rows = parseJsonl(stdout);
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual(['a1', 'm1']);
  });

  it('--since accepts a relative duration and filters to recent rows', async () => {
    const realNow = Date.now();
    const db = openDatabase(dbPath);
    try {
      await seedEvents(db, [
        {
          id: 'old',
          kind: 'approval.requested',
          payload: {},
          // 2 days ago — outside a 1h window.
          createdAt: new Date(realNow - 2 * 86_400_000),
        },
        {
          id: 'recent',
          kind: 'approval.requested',
          payload: {},
          // 5 minutes ago — inside a 1h window.
          createdAt: new Date(realNow - 5 * 60_000),
        },
      ]);
    } finally {
      db.$sqlite.close();
    }

    const { stdout, exitCode } = await runLogsCli(['--since', '1h', '--json']);
    expect(exitCode === null || exitCode === 0).toBe(true);
    const rows = parseJsonl(stdout);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain('recent');
    expect(ids).not.toContain('old');
  });

  it('--agent filters events by agent_id embedded in the payload', async () => {
    const db = openDatabase(dbPath);
    try {
      // Seed two agent rows + a run row so the implementation can also use
      // run-id joins if it wants. The basic filter we assert here works
      // purely on the payload `agent_id` field.
      await db.insert(agents).values([
        {
          id: 'alpha',
          version: '1',
          definitionPath: 'agents/alpha.md',
          hash: '0',
          createdAt: new Date(),
        },
        {
          id: 'beta',
          version: '1',
          definitionPath: 'agents/beta.md',
          hash: '0',
          createdAt: new Date(),
        },
      ]);
      await db.insert(runs).values({
        id: randomUUID(),
        agentId: 'alpha',
        status: 'succeeded',
        startedAt: new Date(now - 90_000),
        provider: 'fake',
        model: 'fake-model',
      });
      await seedEvents(db, [
        {
          id: 'al1',
          kind: 'memory.created',
          payload: { agent_id: 'alpha', scope: 'project' },
          createdAt: new Date(now - 80_000),
        },
        {
          id: 'be1',
          kind: 'memory.created',
          payload: { agent_id: 'beta', scope: 'project' },
          createdAt: new Date(now - 70_000),
        },
        {
          id: 'al2',
          kind: 'memory.denied',
          payload: { agent_id: 'alpha', reason: 'no scope' },
          createdAt: new Date(now - 60_000),
        },
      ]);
    } finally {
      db.$sqlite.close();
    }

    const { stdout, exitCode } = await runLogsCli(['--agent', 'alpha', '--json']);
    expect(exitCode === null || exitCode === 0).toBe(true);
    const rows = parseJsonl(stdout);
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual(['al1', 'al2']);
  });

  it('--limit caps the number of returned rows', async () => {
    const db = openDatabase(dbPath);
    try {
      const seed: SeedRow[] = [];
      for (let i = 0; i < 10; i++) {
        seed.push({
          id: `e${i}`,
          kind: 'approval.requested',
          payload: { i },
          createdAt: new Date(now - (10 - i) * 1000),
        });
      }
      await seedEvents(db, seed);
    } finally {
      db.$sqlite.close();
    }

    const { stdout, exitCode } = await runLogsCli(['--limit', '3', '--json']);
    expect(exitCode === null || exitCode === 0).toBe(true);
    const rows = parseJsonl(stdout);
    expect(rows).toHaveLength(3);
    // Reverse-chrono so the three most recent are returned.
    expect(rows.map((r) => r.id)).toEqual(['e9', 'e8', 'e7']);
  });

  it('emits a "no events match" stanza when the table is empty (default pretty output)', async () => {
    const { stdout, exitCode } = await runLogsCli([]);
    expect(exitCode === null || exitCode === 0).toBe(true);
    expect(stdout).toMatch(/no events match/);
  });

  it('runs with ANTHROPIC_API_KEY and OPENAI_API_KEY unset (PRD §4 quality bar)', async () => {
    const savedAnthropic = process.env.ANTHROPIC_API_KEY;
    const savedOpenai = process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      const db = openDatabase(dbPath);
      try {
        await seedEvents(db, [
          {
            id: 'only',
            kind: 'approval.requested',
            payload: {},
            createdAt: new Date(now),
          },
        ]);
      } finally {
        db.$sqlite.close();
      }

      const { stdout, exitCode } = await runLogsCli(['--json']);
      expect(exitCode === null || exitCode === 0).toBe(true);
      const rows = parseJsonl(stdout);
      expect(rows.map((r) => r.id)).toEqual(['only']);
    } finally {
      if (savedAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = savedAnthropic;
      if (savedOpenai !== undefined) process.env.OPENAI_API_KEY = savedOpenai;
    }
  });
});
