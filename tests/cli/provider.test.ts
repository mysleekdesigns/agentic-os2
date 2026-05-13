import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import yaml from 'js-yaml';

import { buildProgram } from '../../src/cli/index.js';
import { runInit } from '../../src/cli/commands/init.js';

interface ProviderListRow {
  id: string;
  enabled: boolean;
  requires_api_key: boolean;
  api_key_env: string | null;
  api_key_present: boolean;
  capabilities: {
    streaming: boolean;
    tools: boolean;
    mcp: boolean;
    vision: boolean;
    costMetering: boolean;
    promptCaching: boolean;
  };
  factory_registered: boolean;
}

interface EnableJson {
  id: string;
  enabled: boolean;
  api_key_env: string | null;
  api_key_present: boolean;
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

describe('agent-os provider', () => {
  let tmpDir: string;
  let originalCwd: string;
  let originalAnthropicKey: string | undefined;
  let originalOpenAiKey: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agent-os-provider-'));
    runInit({ cwd: tmpDir });
    originalCwd = process.cwd();
    process.chdir(tmpDir);
    // Force the API keys unset for deterministic api_key_present assertions.
    originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
    originalOpenAiKey = process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
    if (originalAnthropicKey !== undefined) process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
    if (originalOpenAiKey !== undefined) process.env.OPENAI_API_KEY = originalOpenAiKey;
  });

  it('list --json reports claude_code_local enabled and no key required', async () => {
    const { stdout, exitCode } = await runCli(['provider', 'list', '--json']);
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout) as ProviderListRow[];
    const local = parsed.find((r) => r.id === 'claude_code_local');
    expect(local).toBeDefined();
    expect(local!.enabled).toBe(true);
    expect(local!.requires_api_key).toBe(false);
    expect(local!.api_key_present).toBe(false);
    expect(local!.capabilities.streaming).toBe(true);

    const anthropic = parsed.find((r) => r.id === 'anthropic_api');
    expect(anthropic).toBeDefined();
    expect(anthropic!.requires_api_key).toBe(true);
    expect(anthropic!.api_key_env).toBe('ANTHROPIC_API_KEY');
  });

  it('list pretty output mentions every provider id', async () => {
    const { stdout, exitCode } = await runCli(['provider', 'list']);
    expect(exitCode).toBeNull();
    expect(stdout).toContain('claude_code_local');
    expect(stdout).toContain('anthropic_api');
    expect(stdout).toContain('openai_api');
  });

  it('enable anthropic_api flips the YAML and warns when the api key env is unset', async () => {
    const { stdout, stderr, exitCode } = await runCli([
      'provider',
      'enable',
      'anthropic_api',
      '--json',
    ]);
    expect(exitCode === null || exitCode === 0).toBe(true);
    const payload = JSON.parse(stdout) as EnableJson;
    expect(payload.id).toBe('anthropic_api');
    expect(payload.enabled).toBe(true);
    expect(payload.api_key_present).toBe(false);
    expect(stderr).toMatch(/ANTHROPIC_API_KEY is not set/);

    const yamlRaw = readFileSync(join(tmpDir, 'agent-os.config.yaml'), 'utf8');
    const parsed = yaml.load(yamlRaw) as {
      providers: { anthropic_api: { enabled: boolean } };
    };
    expect(parsed.providers.anthropic_api.enabled).toBe(true);
  });

  it('enable --disable flips the flag back to false', async () => {
    await runCli(['provider', 'enable', 'anthropic_api']);
    const { exitCode } = await runCli(['provider', 'enable', 'anthropic_api', '--disable']);
    expect(exitCode === null || exitCode === 0).toBe(true);
    const yamlRaw = readFileSync(join(tmpDir, 'agent-os.config.yaml'), 'utf8');
    const parsed = yaml.load(yamlRaw) as {
      providers: { anthropic_api: { enabled: boolean } };
    };
    expect(parsed.providers.anthropic_api.enabled).toBe(false);
  });

  it('enable unknown_provider exits 1', async () => {
    const { stderr, exitCode } = await runCli(['provider', 'enable', 'unknown_provider']);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/unknown provider/);
  });
});

describe('buildProviderCommand wiring', () => {
  it('exposes list/enable subcommands under the `provider` group', () => {
    const program = buildProgram();
    const cmd = program.commands.find((c) => c.name() === 'provider');
    expect(cmd).toBeDefined();
    const subs = cmd!.commands.map((c) => c.name());
    expect(subs).toContain('list');
    expect(subs).toContain('enable');
  });
});
