import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildProgram } from '../../src/cli/index.js';
import { runInit } from '../../src/cli/commands/init.js';

interface ListRow {
  id: string;
  risk: string;
  source: string;
  description?: string;
}

interface TestReport {
  tool: string;
  risk: string;
  source: string;
  verdict: 'allow' | 'approval_required' | 'deny' | 'unknown';
  reason: string;
}

const SAMPLE_AGENT = `---
id: tooltest
name: Tool Test Agent
version: 1
role: A tiny agent used by tools.test.ts.
provider: claude_code_local
tools:
  allowed:
    - mcp.crawlforge.search_web
    - fs.read
  approval_required:
    - mcp.crawlforge.scrape_with_actions
permissions:
  network: approval_required
  file_read: allow
  file_write: approval_required
  shell: deny
memory:
  read: [project]
  write: [project]
---
Hello from tooltest.
`;

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

describe('agent-os tools', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agent-os-tools-'));
    runInit({ cwd: tmpDir });
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('list prints a table containing at least one known builtin tool', async () => {
    const { stdout, exitCode } = await runCli(['tools', 'list']);
    expect(exitCode).toBeNull();
    expect(stdout).toContain('TOOL');
    expect(stdout).toContain('fs.read');
    expect(stdout).toContain('builtin');
  });

  it('list --json returns an array of {id,risk,source}', async () => {
    const { stdout, exitCode } = await runCli(['tools', 'list', '--json']);
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout) as ListRow[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    for (const row of parsed) {
      expect(typeof row.id).toBe('string');
      expect(typeof row.risk).toBe('string');
      expect(typeof row.source).toBe('string');
    }
    expect(parsed.some((r) => r.id === 'fs.read' && r.source === 'builtin')).toBe(true);
  });

  it('list --agent merges the agent tools into the registry', async () => {
    writeFileSync(join(tmpDir, 'agents', 'tooltest.md'), SAMPLE_AGENT);
    const { stdout, exitCode } = await runCli(['tools', 'list', '--agent', 'tooltest', '--json']);
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout) as ListRow[];
    // The agent declares an MCP tool that is NOT in the builtin registry.
    const agentTool = parsed.find((r) => r.id === 'mcp.crawlforge.search_web');
    expect(agentTool).toBeDefined();
    expect(agentTool!.source).toBe('agent:tooltest');
    // And the builtin survives in the merged listing.
    expect(parsed.some((r) => r.id === 'fs.read' && r.source === 'builtin')).toBe(true);
  });

  it('test fs.read --json returns verdict=allow', async () => {
    const { stdout, exitCode } = await runCli(['tools', 'test', 'fs.read', '--json']);
    expect(exitCode === null || exitCode === 0).toBe(true);
    const report = JSON.parse(stdout) as TestReport;
    expect(report.tool).toBe('fs.read');
    expect(report.verdict).toBe('allow');
    expect(report.risk).toBe('read');
  });

  it('test shell.exec --json returns a verdict matching its risk policy', async () => {
    const { stdout, exitCode } = await runCli(['tools', 'test', 'shell.exec', '--json']);
    expect(exitCode === null || exitCode === 0).toBe(true);
    const report = JSON.parse(stdout) as TestReport;
    expect(report.tool).toBe('shell.exec');
    expect(report.risk).toBe('shell');
    // shell risk is approval_required by default; the dry-run synthesises an
    // empty allow-list agent, so the verdict resolves to approval_required.
    expect(report.verdict).toBe('approval_required');
  });

  it('test on an unknown tool with no --agent exits 1', async () => {
    const { exitCode } = await runCli(['tools', 'test', 'nope.unknown', '--json']);
    expect(exitCode).toBe(1);
  });
});

describe('buildToolsCommand wiring', () => {
  it('exposes list/test subcommands under the `tools` group', () => {
    const program = buildProgram();
    const toolsCmd = program.commands.find((c) => c.name() === 'tools');
    expect(toolsCmd).toBeDefined();
    const subs = toolsCmd!.commands.map((c) => c.name());
    expect(subs).toContain('list');
    expect(subs).toContain('test');
  });
});
