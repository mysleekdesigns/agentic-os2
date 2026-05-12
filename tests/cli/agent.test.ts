import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildProgram } from '../../src/cli/index.js';
import { runInit } from '../../src/cli/commands/init.js';

interface ListJsonRow {
  id: string;
  name: string;
  version: number;
  provider: string;
  model: string | null;
  path: string;
  hash: string;
}

interface SyncJsonReport {
  registry: { inserted: number; updated: number; unchanged: number };
  mirror: { written: string[]; removed: string[] };
}

const SAMPLE_AGENT = `---
id: foo
name: Foo Agent
version: 1
role: A small testing agent.
provider: claude_code_local
tools:
  allowed: [read]
  approval_required: [write]
permissions:
  network: deny
  file_read: allow
  file_write: approval_required
  shell: deny
memory:
  read: [project]
  write: [project]
---
Hello from foo.
`;

/**
 * Drive a single Commander invocation against a freshly-built program,
 * capturing stdout/stderr and any `process.exit` exit code.
 */
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

  const program = buildProgram();
  program.exitOverride();

  try {
    await program.parseAsync(['node', 'agent-os', ...argv]);
  } catch (err) {
    // Either our mocked `process.exit` threw, or Commander's exitOverride did.
    // Both are expected control-flow signals; nothing further to do here.
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

describe('agent-os agent', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agent-os-agent-'));
    runInit({ cwd: tmpDir });
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('list prints a friendly message when no agents are present', async () => {
    const { stdout, exitCode } = await runCli(['agent', 'list']);
    expect(exitCode).toBeNull();
    expect(stdout).toMatch(/No agents found in/);
  });

  it('list --json returns an array containing the loaded agent', async () => {
    writeFileSync(join(tmpDir, 'agents', 'foo.md'), SAMPLE_AGENT);

    const { stdout, exitCode } = await runCli(['agent', 'list', '--json']);
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout) as ListJsonRow[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.id).toBe('foo');
    expect(parsed[0]!.name).toBe('Foo Agent');
    expect(parsed[0]!.version).toBe(1);
    expect(parsed[0]!.provider).toBe('claude_code_local');
  });

  it('show renders the agent frontmatter and body', async () => {
    writeFileSync(join(tmpDir, 'agents', 'foo.md'), SAMPLE_AGENT);

    const { stdout, exitCode } = await runCli(['agent', 'show', 'foo']);
    expect(exitCode).toBeNull();
    expect(stdout).toContain('id: foo');
    expect(stdout).toContain('name: Foo Agent');
    expect(stdout).toContain('role: A small testing agent.');
    expect(stdout).toContain('---');
    expect(stdout).toContain('Hello from foo.');
  });

  it('show exits 1 when the agent id is unknown', async () => {
    writeFileSync(join(tmpDir, 'agents', 'foo.md'), SAMPLE_AGENT);

    const { stderr, exitCode } = await runCli(['agent', 'show', 'missing']);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Agent not found: missing/);
  });

  it('sync inserts a new agent and reports unchanged on a second run', async () => {
    writeFileSync(join(tmpDir, 'agents', 'foo.md'), SAMPLE_AGENT);

    const first = await runCli(['agent', 'sync', '--json']);
    expect(first.exitCode).toBeNull();
    const firstReport = JSON.parse(first.stdout) as SyncJsonReport;
    expect(firstReport.registry.inserted).toBe(1);
    expect(firstReport.registry.updated).toBe(0);
    expect(firstReport.registry.unchanged).toBe(0);
    expect(firstReport.mirror.written.length).toBeGreaterThanOrEqual(1);

    const mirrored = join(tmpDir, '.claude', 'agents', 'foo.md');
    expect(existsSync(mirrored)).toBe(true);
    // Mirror may reshape / reserialise the frontmatter; just confirm the
    // identifying fields and body landed in the destination.
    const mirroredText = readFileSync(mirrored, 'utf8');
    expect(mirroredText).toContain('id: foo');
    expect(mirroredText).toContain('name: Foo Agent');
    expect(mirroredText).toContain('Hello from foo.');

    const second = await runCli(['agent', 'sync', '--json']);
    expect(second.exitCode).toBeNull();
    const secondReport = JSON.parse(second.stdout) as SyncJsonReport;
    expect(secondReport.registry.inserted).toBe(0);
    expect(secondReport.registry.unchanged).toBe(1);
  });
});

describe('buildAgentCommand wiring', () => {
  it('exposes list/show/sync subcommands under the `agent` group', async () => {
    const program = buildProgram();
    const agentCmd = program.commands.find((c) => c.name() === 'agent');
    expect(agentCmd).toBeDefined();
    const subs = agentCmd!.commands.map((c) => c.name());
    expect(subs).toContain('list');
    expect(subs).toContain('show');
    expect(subs).toContain('sync');
  });
});

// Suppress an unused-symbol lint complaint when the tmp workspace is created
// without writing any agents (the `list` empty-state test).
void mkdirSync;
