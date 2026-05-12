/**
 * CLI surface tests for `agent-os eval run` / `agent-os eval diff`.
 *
 * Pattern mirrors `tests/cli/run.test.ts`: spy on stdout/stderr/exit, drive the
 * Commander program via `buildProgram().parseAsync`, and pre-register a
 * `FakeProvider` so the CLI never touches a real adapter.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildProgram } from '../../src/cli/index.js';
import { runInit } from '../../src/cli/commands/init.js';
import type { RunEvent } from '../../src/core/providers/index.js';
import {
  FakeProvider,
  registerProvider,
  scriptedTranscript,
  unregisterProvider,
} from '../../src/core/providers/index.js';
import { openDatabase } from '../../src/storage/db.js';
import { runMigrations } from '../../src/storage/migrate.js';
import { evalResults } from '../../src/storage/schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function copyResearchAgent(tmpDir: string): void {
  const src = resolve(__dirname, '..', '..', 'agents', 'templates', 'research_agent.md');
  const body = readFileSync(src, 'utf8');
  writeFileSync(join(tmpDir, 'agents', 'research_agent.md'), body);
}

function writeFixture(tmpDir: string, name: string, body: string): string {
  const dir = join(tmpDir, 'evals', 'fixtures', 'research_agent');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}

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

  // process.exitCode lingers across runs; capture and reset it.
  const priorExitCode = process.exitCode;
  process.exitCode = 0;

  const program = buildProgram();
  program.exitOverride();

  try {
    await program.parseAsync(['node', 'agent-os', ...argv]);
  } catch {
    /* swallow Commander's exitOverride and our exit stub */
  } finally {
    if (exitCode === null && typeof process.exitCode === 'number' && process.exitCode !== 0) {
      exitCode = process.exitCode;
    }
    process.exitCode = priorExitCode;
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

const SUCCESS_OUTPUT = 'hello world success';
const FAILURE_OUTPUT = 'totally unrelated';

const PASSING_FIXTURE = `description: smoke
prompts:
  - 'go'
providers:
  - id: 'agent-os:research_agent'
tests:
  - description: 'happy path'
    assert:
      - type: contains
        value: 'success'
`;

const FAILING_FIXTURE = `description: smoke-fail
prompts:
  - 'go'
providers:
  - id: 'agent-os:research_agent'
tests:
  - description: 'always fails'
    assert:
      - type: contains
        value: 'will never appear'
`;

function makeScriptedProvider(text: string): FakeProvider {
  const events: RunEvent[] = scriptedTranscript()
    .message('assistant', text)
    .done({ reason: 'completed', durationMs: 1 })
    .build();
  return new FakeProvider({ events });
}

describe('agent-os eval run', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agent-os-eval-'));
    runInit({ cwd: tmpDir });
    originalCwd = process.cwd();
    process.chdir(tmpDir);
    copyResearchAgent(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
    unregisterProvider('claude_code_local');
  });

  it('runs a passing fixture, exits 0, persists a row, and writes a snapshot', async () => {
    registerProvider('claude_code_local', () => makeScriptedProvider(SUCCESS_OUTPUT));
    const fixturePath = writeFixture(tmpDir, 'pass.yaml', PASSING_FIXTURE);

    const { stdout, exitCode } = await runCli(['eval', 'run', fixturePath]);
    expect(exitCode === null || exitCode === 0).toBe(true);
    expect(stdout).toMatch(/PASS .+pass\.yaml/);
    expect(stdout).toMatch(/Run [0-9a-f]+: 1 passed, 0 failed/);

    // Snapshot exists.
    const runsDir = join(tmpDir, '.agent-os', 'eval-runs');
    const files = readdirSync(runsDir);
    expect(files.length).toBe(1);
    const report = JSON.parse(readFileSync(join(runsDir, files[0]!), 'utf8')) as {
      passed: boolean;
      fixtures: unknown[];
    };
    expect(report.passed).toBe(true);
    expect(report.fixtures.length).toBe(1);

    // eval_results row persisted.
    const dbPath = join(tmpDir, '.agent-os', 'agent-os.sqlite');
    const db = openDatabase(dbPath);
    try {
      await runMigrations(db, { log: () => undefined });
      const rows = db.select().from(evalResults).all();
      expect(rows.length).toBe(1);
      expect(rows[0]!.passed).toBe(true);
      expect(rows[0]!.score).toBe(100);
    } finally {
      db.$sqlite.close();
    }
  });

  it('exits 1 when an assertion fails, and persists passed=false', async () => {
    registerProvider('claude_code_local', () => makeScriptedProvider(FAILURE_OUTPUT));
    const fixturePath = writeFixture(tmpDir, 'fail.yaml', FAILING_FIXTURE);

    const { stdout, exitCode } = await runCli(['eval', 'run', fixturePath]);
    expect(exitCode).toBe(1);
    expect(stdout).toMatch(/FAIL .+fail\.yaml/);

    const dbPath = join(tmpDir, '.agent-os', 'agent-os.sqlite');
    const db = openDatabase(dbPath);
    try {
      await runMigrations(db, { log: () => undefined });
      const rows = db.select().from(evalResults).all();
      expect(rows.length).toBe(1);
      expect(rows[0]!.passed).toBe(false);
    } finally {
      db.$sqlite.close();
    }
  });

  it('--json emits a parseable EvalRunReport whose .passed reflects the run', async () => {
    registerProvider('claude_code_local', () => makeScriptedProvider(SUCCESS_OUTPUT));
    const fixturePath = writeFixture(tmpDir, 'pass.yaml', PASSING_FIXTURE);

    const { stdout, exitCode } = await runCli(['eval', 'run', fixturePath, '--json']);
    expect(exitCode === null || exitCode === 0).toBe(true);
    const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!) as { passed: boolean; runId: string };
    expect(parsed.passed).toBe(true);
    expect(typeof parsed.runId).toBe('string');
  });
});

describe('agent-os eval diff', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agent-os-eval-diff-'));
    runInit({ cwd: tmpDir });
    originalCwd = process.cwd();
    process.chdir(tmpDir);
    copyResearchAgent(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
    unregisterProvider('claude_code_local');
  });

  async function runEvalCapture(fixturePath: string, output: string): Promise<string> {
    unregisterProvider('claude_code_local');
    registerProvider('claude_code_local', () => makeScriptedProvider(output));
    const before = new Set(
      existsSync(join(tmpDir, '.agent-os', 'eval-runs'))
        ? readdirSync(join(tmpDir, '.agent-os', 'eval-runs'))
        : [],
    );
    await runCli(['eval', 'run', fixturePath]);
    const runsDir = join(tmpDir, '.agent-os', 'eval-runs');
    const after = readdirSync(runsDir);
    const fresh = after.find((f) => !before.has(f));
    if (!fresh) throw new Error('no new snapshot produced');
    return fresh.replace(/\.json$/, '');
  }

  it('reports "no differences" when both runs match', async () => {
    const fixturePath = writeFixture(tmpDir, 'pass.yaml', PASSING_FIXTURE);
    const runA = await runEvalCapture(fixturePath, SUCCESS_OUTPUT);
    const runB = await runEvalCapture(fixturePath, SUCCESS_OUTPUT);

    const { stdout, exitCode } = await runCli(['eval', 'diff', runA, runB]);
    expect(exitCode === null || exitCode === 0).toBe(true);
    expect(stdout).toContain('no differences');
  });

  it('exits 1 and reports "regressed" when run B fails what run A passed', async () => {
    // A passes; B uses the same fixture text but the agent answer fails the assertion.
    const fixturePath = writeFixture(tmpDir, 'pass.yaml', PASSING_FIXTURE);
    const runA = await runEvalCapture(fixturePath, SUCCESS_OUTPUT);
    const runB = await runEvalCapture(fixturePath, FAILURE_OUTPUT);

    const { stdout, exitCode } = await runCli(['eval', 'diff', runA, runB]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain('regressed');
  });
});

describe('buildEvalCommand wiring', () => {
  it('exposes an `eval` command on the top-level program with `run` and `diff` subcommands', () => {
    const program = buildProgram();
    const evalCmd = program.commands.find((c) => c.name() === 'eval');
    expect(evalCmd).toBeDefined();
    const subs = evalCmd!.commands.map((c) => c.name()).sort();
    expect(subs).toEqual(['diff', 'run']);
  });
});
