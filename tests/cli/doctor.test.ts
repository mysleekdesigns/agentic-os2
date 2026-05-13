import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildProgram } from '../../src/cli/index.js';
import { runInit } from '../../src/cli/commands/init.js';
import { openDatabase } from '../../src/storage/db.js';
import { runMigrations } from '../../src/storage/migrate.js';

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

async function runCli(argv: readonly string[]): Promise<CliResult> {
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

  const program = buildProgram();
  program.exitOverride();

  try {
    await program.parseAsync(['node', 'agent-os', ...argv]);
  } catch (err) {
    void err;
  } finally {
    writeStdout.mockRestore();
    writeStderr.mockRestore();
    exit.mockRestore();
  }

  return {
    stdout: stdoutChunks.join(''),
    stderr: stderrChunks.join(''),
    exitCode,
  };
}

describe('agent-os doctor', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agent-os-doctor-'));
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports a sectioned health check after init', async () => {
    runInit({ cwd: tmpDir });

    const { stdout, exitCode } = await runCli(['doctor']);

    // Workspace OK + db file not yet created — db.open=false → exitCode 1.
    expect(exitCode).toBe(1);
    expect(stdout).toContain('agent-os doctor');
    expect(stdout).toContain('workspace');
    expect(stdout).toContain('providers');
    expect(stdout).toContain('database');
    expect(stdout).toContain('claude_code_local');
  });

  it('--json emits a parseable DoctorReport with the documented shape', async () => {
    runInit({ cwd: tmpDir });

    const { stdout } = await runCli(['doctor', '--json']);

    const lines = stdout.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    const report = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(typeof report.ok).toBe('boolean');
    expect(report.workspace).toBeDefined();
    expect(report.providers).toBeInstanceOf(Array);
    expect(report.mcp).toBeDefined();
    expect(report.db).toBeDefined();
    expect(report.versions).toBeDefined();
    expect(report.warnings).toBeInstanceOf(Array);

    const versions = report.versions as Record<string, unknown>;
    expect(typeof versions.agentOs).toBe('string');
    expect(typeof versions.node).toBe('string');

    const providers = report.providers as Array<Record<string, unknown>>;
    const ids = providers.map((p) => p.id);
    expect(ids).toContain('claude_code_local');
    expect(ids).toContain('anthropic_api');
    expect(ids).toContain('openai_api');
  });

  it('exit 1 and warning when there is no config file', async () => {
    // No init — empty tmp dir.
    const { stdout, exitCode } = await runCli(['doctor']);
    expect(exitCode).toBe(1);
    expect(stdout.toLowerCase()).toContain('missing');
    expect(stdout).toContain('status: FAIL');
  });

  it('reports migrations applied after running migrate', async () => {
    runInit({ cwd: tmpDir });
    const dbPath = join(tmpDir, '.agent-os', 'agent-os.sqlite');
    const db = openDatabase(dbPath);
    try {
      await runMigrations(db, { log: () => undefined });
    } finally {
      db.$sqlite.close();
    }

    const { stdout, exitCode } = await runCli(['doctor', '--json']);
    expect(exitCode === null || exitCode === 0 || exitCode === 1).toBe(true);
    const report = JSON.parse(stdout.trim()) as {
      db: { migrationsApplied: number; lastMigration: string | null };
    };
    expect(report.db.migrationsApplied).toBeGreaterThan(0);
    expect(report.db.lastMigration).not.toBeNull();
  });
});

describe('buildDoctorCommand wiring', () => {
  it('exposes a `doctor` command on the top-level program', () => {
    const program = buildProgram();
    const doctor = program.commands.find((c) => c.name() === 'doctor');
    expect(doctor).toBeDefined();
  });
});
