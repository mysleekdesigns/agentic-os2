import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { buildProgram } from '../../src/cli/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

function readPackageVersion(): string {
  const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', '..', 'package.json'), 'utf8')) as {
    version: string;
  };
  return pkg.version;
}

describe('agent-os version', () => {
  it('prints the package.json version', async () => {
    const expected = readPackageVersion();
    const { stdout } = await runCli(['version']);
    expect(stdout.trim()).toBe(expected);
  });

  it('--json emits { name, version, node }', async () => {
    const expected = readPackageVersion();
    const { stdout } = await runCli(['version', '--json']);
    const payload = JSON.parse(stdout.trim()) as {
      name: string;
      version: string;
      node: string;
    };
    expect(payload.name).toBe('agent-os');
    expect(payload.version).toBe(expected);
    expect(typeof payload.node).toBe('string');
    expect(payload.node.length).toBeGreaterThan(0);
  });
});
