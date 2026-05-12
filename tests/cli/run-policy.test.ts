import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildProgram } from '../../src/cli/index.js';
import { runInit } from '../../src/cli/commands/init.js';
import {
  FakeProvider,
  registerProvider,
  scriptedTranscript,
  unregisterProvider,
} from '../../src/core/providers/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function copyResearchAgent(tmpDir: string): void {
  const src = resolve(__dirname, '..', '..', 'agents', 'templates', 'research_agent.md');
  const body = readFileSync(src, 'utf8');
  writeFileSync(join(tmpDir, 'agents', 'research_agent.md'), body);
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

describe('agent-os run — policy enforcement', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agent-os-run-policy-'));
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

  it('--no-audit + denied destructive tool: synthetic deny result visible, exit 0', async () => {
    const events = scriptedTranscript()
      .toolCall('fs.rm', { path: '/' })
      .done({ reason: 'completed', durationMs: 5 })
      .build();
    registerProvider('claude_code_local', () => new FakeProvider({ events }));

    const { stdout, exitCode } = await runCli([
      'run',
      'research_agent',
      '--no-audit',
      '--no-color',
      'goal',
    ]);
    expect(exitCode === null || exitCode === 0).toBe(true);
    expect(stdout).toMatch(/approval/);
    // Synthetic deny result is an error tool_result.
    expect(stdout).toMatch(/tool_result/);
  });

  it('--no-audit + --auto-approve passes an approval_required tool through', async () => {
    const events = scriptedTranscript()
      .toolCall('fs.write', { path: '/x' })
      .toolResult('wrote')
      .done({ reason: 'completed', durationMs: 5 })
      .build();
    registerProvider('claude_code_local', () => new FakeProvider({ events }));

    const { stdout, exitCode } = await runCli([
      'run',
      'research_agent',
      '--no-audit',
      '--auto-approve',
      '--no-color',
      'goal',
    ]);
    expect(exitCode === null || exitCode === 0).toBe(true);
    // The original tool_call should appear because --auto-approve approved it.
    expect(stdout).toMatch(/tool_call fs\.write/);
  });

  it('--no-audit without --auto-approve rejects approval_required tools in non-TTY mode', async () => {
    const events = scriptedTranscript()
      .toolCall('fs.write', { path: '/x' })
      .done({ reason: 'completed', durationMs: 5 })
      .build();
    registerProvider('claude_code_local', () => new FakeProvider({ events }));

    const { stdout, exitCode } = await runCli([
      'run',
      'research_agent',
      '--no-audit',
      '--no-color',
      'goal',
    ]);
    expect(exitCode === null || exitCode === 0).toBe(true);
    expect(stdout).toMatch(/approval/);
    // The original allowed tool_call should NOT pass through.
    expect(stdout).not.toMatch(/^.*tool_call fs\.write.*$/m);
  });

  it('--no-audit lets allowed tools pass through unchanged', async () => {
    const events = scriptedTranscript()
      .toolCall('fs.read', { path: '/etc/hosts' })
      .toolResult('contents')
      .done({ reason: 'completed', durationMs: 1 })
      .build();
    registerProvider('claude_code_local', () => new FakeProvider({ events }));

    const { stdout, exitCode } = await runCli([
      'run',
      'research_agent',
      '--no-audit',
      '--no-color',
      'goal',
    ]);
    expect(exitCode === null || exitCode === 0).toBe(true);
    expect(stdout).toMatch(/tool_call fs\.read/);
    expect(stdout).not.toMatch(/approval/);
  });
});
