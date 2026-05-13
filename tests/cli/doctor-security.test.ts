import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildProgram } from '../../src/cli/index.js';
import { runInit } from '../../src/cli/commands/init.js';

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

/**
 * Write an `.mcp.json` file with the given server entries into `dir`. Keeps the
 * test bodies declarative and avoids re-pasting the JSON envelope each time.
 */
function writeMcpJson(dir: string, servers: Record<string, unknown>): void {
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: servers }, null, 2));
}

/**
 * Mutate the YAML config produced by `runInit` with a simple line replacement.
 * We avoid pulling in a YAML serializer because the default config layout is
 * stable and `pinned_mcp_servers:` / `destructive:` appear on a single line.
 */
function rewriteConfig(dir: string, replacements: Array<[RegExp, string]>): void {
  const path = join(dir, 'agent-os.config.yaml');
  let yaml = readFileSync(path, 'utf8');
  for (const [pattern, replacement] of replacements) {
    yaml = yaml.replace(pattern, replacement);
  }
  writeFileSync(path, yaml);
}

describe('agent-os doctor --security', () => {
  let tmpDir: string;
  let binDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agent-os-doctor-sec-'));
    binDir = mkdtempSync(join(tmpdir(), 'agent-os-doctor-bin-'));
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  });

  it('init defaults with no .mcp.json: status OK, exit 0', async () => {
    runInit({ cwd: tmpDir });

    const { stdout, exitCode } = await runCli(['doctor', '--security']);

    expect(exitCode === null || exitCode === 0).toBe(true);
    expect(stdout).toContain('agent-os doctor --security');
    expect(stdout).toContain('default_tool_policy: deny');
    expect(stdout).toContain('risk_levels.destructive: deny');
    expect(stdout).toContain('pinned_mcp_servers: true');
    expect(stdout).toContain('status: OK');
    expect(stdout).not.toContain('findings');
  });

  it('pinned + .mcp.json missing command_sha256: status FAIL with finding', async () => {
    runInit({ cwd: tmpDir });
    writeMcpJson(tmpDir, {
      myserver: { command: 'node', args: ['/some/server.js'] },
    });

    const { stdout, exitCode } = await runCli(['doctor', '--security']);

    expect(exitCode).toBe(1);
    expect(stdout).toContain('myserver: UNPINNED');
    expect(stdout).toMatch(/mcp\.myserver: missing command_sha256/);
    expect(stdout).toContain('status: FAIL');
  });

  it('command_sha256 matches the file on disk: status OK', async () => {
    runInit({ cwd: tmpDir });
    const binaryPath = join(binDir, 'server.js');
    const contents = 'console.log("hi");\n';
    writeFileSync(binaryPath, contents);
    const digest = createHash('sha256').update(contents).digest('hex');

    writeMcpJson(tmpDir, {
      myserver: {
        command: binaryPath,
        args: [],
        command_sha256: digest,
      },
    });

    const { stdout, exitCode } = await runCli(['doctor', '--security']);

    expect(exitCode === null || exitCode === 0).toBe(true);
    expect(stdout).toContain('myserver: pinned (sha256 ok)');
    expect(stdout).toContain('status: OK');
  });

  it('command_sha256 set to a wrong value: status FAIL with mismatch finding', async () => {
    runInit({ cwd: tmpDir });
    const binaryPath = join(binDir, 'server.js');
    writeFileSync(binaryPath, 'console.log("real");\n');

    writeMcpJson(tmpDir, {
      myserver: {
        command: binaryPath,
        args: [],
        // Deliberately bogus checksum.
        command_sha256: 'deadbeef'.repeat(8),
      },
    });

    const { stdout, exitCode } = await runCli(['doctor', '--security']);

    expect(exitCode).toBe(1);
    expect(stdout).toContain('myserver: CHECKSUM MISMATCH');
    expect(stdout).toMatch(/command_sha256 mismatch/);
    expect(stdout).toContain('status: FAIL');
  });

  it('--security --json emits only the security subset of the report', async () => {
    runInit({ cwd: tmpDir });

    const { stdout } = await runCli(['doctor', '--security', '--json']);

    const lines = stdout.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0]!) as Record<string, unknown>;

    // Required security fields are present.
    expect(payload).toHaveProperty('default_tool_policy');
    expect(payload).toHaveProperty('risk_levels');
    expect(payload).toHaveProperty('pinned_mcp_servers');
    expect(payload).toHaveProperty('redact_secrets_in_logs');
    expect(payload).toHaveProperty('mcpServers');
    expect(payload).toHaveProperty('findings');
    expect(payload).toHaveProperty('ok');

    // Full-report fields are NOT present.
    expect(payload).not.toHaveProperty('providers');
    expect(payload).not.toHaveProperty('db');
    expect(payload).not.toHaveProperty('versions');
    expect(payload).not.toHaveProperty('workspace');
    expect(payload).not.toHaveProperty('mcp');
  });

  it('lowering risk_levels.destructive to approval_required: finding + ok=false', async () => {
    runInit({ cwd: tmpDir });
    rewriteConfig(tmpDir, [[/destructive:\s*deny/, 'destructive: approval_required']]);

    const { stdout, exitCode } = await runCli(['doctor', '--security']);

    expect(exitCode).toBe(1);
    expect(stdout).toContain('risk_levels.destructive: approval_required');
    expect(stdout).toMatch(/destructive.*approval_required.*expected.*deny/);
    expect(stdout).toContain('status: FAIL');
  });

  it('full --json report still includes the security field', async () => {
    runInit({ cwd: tmpDir });

    const { stdout } = await runCli(['doctor', '--json']);
    const lines = stdout.split('\n').filter((l) => l.length > 0);
    const report = JSON.parse(lines[0]!) as Record<string, unknown>;

    expect(report).toHaveProperty('security');
    const sec = report.security as Record<string, unknown>;
    expect(typeof sec.ok).toBe('boolean');
    expect(sec).toHaveProperty('mcpServers');
    expect(sec).toHaveProperty('findings');
  });
});
