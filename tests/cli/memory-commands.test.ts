/**
 * CLI tests for `agent-os memory` (PRD §3 Phase 7).
 *
 * Provisions a real tmp workspace via `runInit`, drives the command surface
 * through a fresh Commander program built from `buildMemoryCommand()`
 * (mirroring `tests/cli/workflow.test.ts`), and asserts row / blob / file
 * state on disk.
 *
 * Per-agent denial path: a CLI write with `--agent-id <id>` to a scope NOT in
 * that agent's `memory.write` allow-list must exit non-zero AND emit a
 * `memory.denied` event row in the events table.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { Command } from 'commander';

import { buildMemoryCommand } from '../../src/cli/commands/memory.js';
import { runInit } from '../../src/cli/commands/init.js';
import { openDatabase } from '../../src/storage/db.js';
import { runMigrations } from '../../src/storage/migrate.js';
import { events, memory } from '../../src/storage/schema.js';

// ---------------------------------------------------------------------------
// CLI harness (mirrors tests/cli/workflow.test.ts)
// ---------------------------------------------------------------------------

async function runCli(argv: readonly string[]): Promise<{
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

  // Build a fresh Commander program containing JUST the memory command so the
  // test does not depend on `buildProgram()` wiring memory in yet.
  const program = new Command();
  program.name('agent-os').exitOverride();
  program.addCommand(buildMemoryCommand());

  try {
    await program.parseAsync(['node', 'agent-os', ...argv]);
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
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Write a minimal agent definition under `<workspace>/agents/` so the CLI's
 * agent-id path can resolve it. Shape per PRD §2.6 / `AgentFrontmatterSchema`.
 */
function writeAgentFixture(
  workspaceRoot: string,
  args: {
    id: string;
    memoryRead?: string[];
    memoryWrite?: string[];
  },
): void {
  const dir = join(workspaceRoot, 'agents');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${args.id}.md`);
  const frontmatter = `---
id: ${args.id}
name: ${args.id}
version: 1
role: tester
provider: claude_code_local
tools:
  allowed: []
  approval_required: []
permissions:
  network: deny
  file_read: allow
  file_write: deny
  shell: deny
memory:
  read: ${JSON.stringify(args.memoryRead ?? [])}
  write: ${JSON.stringify(args.memoryWrite ?? [])}
---

# ${args.id}

Test agent.
`;
  writeFileSync(file, frontmatter);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('agent-os memory (CLI)', () => {
  let tmpDir: string;
  let originalCwd: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agent-os-memory-cli-'));
    runInit({ cwd: tmpDir });
    originalCwd = process.cwd();
    process.chdir(tmpDir);
    dbPath = join(tmpDir, '.agent-os', 'db.sqlite');

    // Run migrations up front so the CLI can use the schema.
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

  // -------------------------------------------------------------------------
  // write
  // -------------------------------------------------------------------------

  it('write <scope> <key> --value creates a memory (row + blob + file)', async () => {
    const { exitCode } = await runCli(['memory', 'write', 'project', 'hello', '--value', 'world']);
    expect(exitCode === null || exitCode === 0).toBe(true);

    const db = openDatabase(dbPath);
    try {
      const rows = await db.select().from(memory).where(eq(memory.key, 'hello'));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.scope).toBe('project');
      expect(rows[0]!.revision).toBe(1);
    } finally {
      db.$sqlite.close();
    }
  });

  it('second write to the same (scope,key) without --note errors with a clear message', async () => {
    await runCli(['memory', 'write', 'project', 'dup', '--value', 'first']);
    const { stderr, exitCode } = await runCli([
      'memory',
      'write',
      'project',
      'dup',
      '--value',
      'second',
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/already exists|update|--note/i);
  });

  it('second write with --note "..." succeeds via updateMemory and increments revision', async () => {
    await runCli(['memory', 'write', 'project', 'note', '--value', 'rev1']);
    const { exitCode } = await runCli([
      'memory',
      'write',
      'project',
      'note',
      '--value',
      'rev2 different',
      '--note',
      'fixed typo',
    ]);
    expect(exitCode === null || exitCode === 0).toBe(true);

    const db = openDatabase(dbPath);
    try {
      const rows = await db.select().from(memory).where(eq(memory.key, 'note'));
      expect(rows[0]!.revision).toBe(2);
    } finally {
      db.$sqlite.close();
    }
  });

  // -------------------------------------------------------------------------
  // list
  // -------------------------------------------------------------------------

  it('list <scope> --json returns an array; --all includes tombstoned', async () => {
    await runCli(['memory', 'write', 'project', 'a', '--value', 'A']);
    await runCli(['memory', 'write', 'project', 'b', '--value', 'B']);
    await runCli(['memory', 'rm', 'project:a']);

    const live = await runCli(['memory', 'list', 'project', '--json']);
    expect(live.exitCode === null || live.exitCode === 0).toBe(true);
    const liveParsed = JSON.parse(live.stdout) as Array<{ key: string }>;
    expect(Array.isArray(liveParsed)).toBe(true);
    expect(liveParsed.map((r) => r.key).sort()).toEqual(['b']);

    const all = await runCli(['memory', 'list', 'project', '--all', '--json']);
    expect(all.exitCode === null || all.exitCode === 0).toBe(true);
    const allParsed = JSON.parse(all.stdout) as Array<{ key: string }>;
    expect(allParsed.map((r) => r.key).sort()).toEqual(['a', 'b']);
  });

  // -------------------------------------------------------------------------
  // show
  // -------------------------------------------------------------------------

  it('show <scope>:<key> and show <id> resolve to the same row', async () => {
    await runCli(['memory', 'write', 'project', 'shown', '--value', 'visible body']);

    const db = openDatabase(dbPath);
    let id: string;
    try {
      const rows = await db.select().from(memory).where(eq(memory.key, 'shown'));
      id = rows[0]!.id;
    } finally {
      db.$sqlite.close();
    }

    const byCompound = await runCli(['memory', 'show', 'project:shown']);
    expect(byCompound.exitCode === null || byCompound.exitCode === 0).toBe(true);
    expect(byCompound.stdout).toContain('visible body');

    const byId = await runCli(['memory', 'show', id]);
    expect(byId.exitCode === null || byId.exitCode === 0).toBe(true);
    expect(byId.stdout).toContain('visible body');
  });

  // -------------------------------------------------------------------------
  // rm
  // -------------------------------------------------------------------------

  it('rm <scope>:<key> tombstones the row', async () => {
    await runCli(['memory', 'write', 'project', 'kill', '--value', 'mortal']);
    const { exitCode } = await runCli(['memory', 'rm', 'project:kill']);
    expect(exitCode === null || exitCode === 0).toBe(true);

    const db = openDatabase(dbPath);
    try {
      const rows = await db.select().from(memory).where(eq(memory.key, 'kill'));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.deletedAt).not.toBeNull();
    } finally {
      db.$sqlite.close();
    }
  });

  // -------------------------------------------------------------------------
  // search
  // -------------------------------------------------------------------------

  it('search "query" --scope <s> returns ranked results', async () => {
    await runCli(['memory', 'write', 'project', 'rocket', '--value', 'rockets fly high']);
    await runCli(['memory', 'write', 'project', 'fish', '--value', 'fish swim deep']);

    const { stdout, exitCode } = await runCli([
      'memory',
      'search',
      'rockets',
      '--scope',
      'project',
      '--json',
    ]);
    expect(exitCode === null || exitCode === 0).toBe(true);
    const parsed = JSON.parse(stdout) as Array<{ entry: { key: string }; score: number }>;
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[0]!.entry.key).toBe('rocket');
  });

  // -------------------------------------------------------------------------
  // per-agent denial path (PRD §3 Phase 7 Exit)
  // -------------------------------------------------------------------------

  it('write <scope> <key> --agent-id <agent-without-write> exits non-zero AND logs memory.denied', async () => {
    writeAgentFixture(tmpDir, {
      id: 'researcher_no_notes',
      memoryRead: ['project'],
      memoryWrite: ['research_notes'],
    });

    const { exitCode } = await runCli([
      'memory',
      'write',
      'notes',
      'illicit',
      '--value',
      'should-not-stick',
      '--agent-id',
      'researcher_no_notes',
    ]);
    expect(exitCode).toBe(1);

    const db = openDatabase(dbPath);
    try {
      // No memory row created.
      const rows = await db.select().from(memory).where(eq(memory.key, 'illicit'));
      expect(rows).toHaveLength(0);

      // A memory.denied audit event exists.
      const ev = await db.select().from(events).where(eq(events.kind, 'memory.denied'));
      expect(ev.length).toBeGreaterThan(0);
      const payloads = ev.map((e) => JSON.parse(e.payload) as Record<string, unknown>);
      const match = payloads.find(
        (p) => p.agent_id === 'researcher_no_notes' && p.scope === 'notes' && p.action === 'write',
      );
      expect(match).toBeDefined();
    } finally {
      db.$sqlite.close();
    }
  });

  // -------------------------------------------------------------------------
  // no-API-key invariant (PRD §4 quality bar)
  // -------------------------------------------------------------------------

  it('runs the surface with ANTHROPIC_API_KEY / OPENAI_API_KEY unset', async () => {
    const savedAnthropic = process.env.ANTHROPIC_API_KEY;
    const savedOpenai = process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const write = await runCli([
        'memory',
        'write',
        'project',
        'no-key',
        '--value',
        'still works',
      ]);
      expect(write.exitCode === null || write.exitCode === 0).toBe(true);

      const list = await runCli(['memory', 'list', 'project', '--json']);
      expect(list.exitCode === null || list.exitCode === 0).toBe(true);
    } finally {
      if (savedAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = savedAnthropic;
      if (savedOpenai !== undefined) process.env.OPENAI_API_KEY = savedOpenai;
    }
  });
});
