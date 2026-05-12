import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildProgram } from '../../src/cli/index.js';
import { runInit } from '../../src/cli/commands/init.js';
import type { AgentRunInput, Provider, RunEvent } from '../../src/core/providers/index.js';
import {
  FakeProvider,
  registerProvider,
  scriptedTranscript,
  unregisterProvider,
} from '../../src/core/providers/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Load the canonical research_agent template from the repo and emit a copy
 * into `<tmp>/agents/`. We use the real template so this test also acts as a
 * smoke test for the agent loader against PRD-shipped content.
 */
function copyResearchAgent(tmpDir: string): void {
  const src = resolve(__dirname, '..', '..', 'agents', 'templates', 'research_agent.md');
  const body = readFileSync(src, 'utf8');
  writeFileSync(join(tmpDir, 'agents', 'research_agent.md'), body);
}

/** A `Provider` wrapper that records every `run()` call's input. */
interface SpyingProvider extends Provider {
  readonly inputs: AgentRunInput[];
}

function makeSpyProvider(events: RunEvent[]): SpyingProvider {
  const fake = new FakeProvider({ events });
  const inputs: AgentRunInput[] = [];
  return {
    id: fake.id,
    capabilities: fake.capabilities,
    inputs,
    run(input: AgentRunInput) {
      inputs.push(input);
      return fake.run(input);
    },
  };
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

describe('agent-os run', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agent-os-run-'));
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

  it('streams the scripted transcript and exits 0 on a completed run', async () => {
    const events = scriptedTranscript()
      .message('assistant', 'hello there')
      .toolCall('fs.read', { path: '/tmp/x' })
      .toolResult('ok')
      .done({ reason: 'completed', durationMs: 42 })
      .build();
    const spy = makeSpyProvider(events);
    registerProvider('claude_code_local', () => spy);

    const { stdout, exitCode } = await runCli([
      'run',
      'research_agent',
      '--no-color',
      'summarize',
      'Crawlforge',
      'MCP',
      'tools',
    ]);

    // Either Commander completed without an explicit exit (null) or we explicitly exited 0.
    expect(exitCode === null || exitCode === 0).toBe(true);

    const lines = stdout.split('\n');
    expect(lines.some((l) => l.includes('→ assistant: hello there'))).toBe(true);
    expect(lines.some((l) => l.includes('tool_call fs.read'))).toBe(true);
    expect(lines.some((l) => l.includes('✓ tool_result'))).toBe(true);
    expect(stdout).toContain('— done (completed) in 42ms');
    expect(stdout).toContain('cost: —');
    expect(stdout).toContain('tokens: —');

    // Confirm the joined goal made it through.
    expect(spy.inputs).toHaveLength(1);
    expect(spy.inputs[0]!.goal).toBe('summarize Crawlforge MCP tools');
    expect(spy.inputs[0]!.agentId).toBe('research_agent');
  });

  it('--json mode emits one JSON object per line', async () => {
    const events = scriptedTranscript()
      .message('assistant', 'hi')
      .toolCall('fs.read', { path: '/x' })
      .toolResult('ok')
      .done({ reason: 'completed', durationMs: 1 })
      .build();
    registerProvider('claude_code_local', () => new FakeProvider({ events }));

    const { stdout, exitCode } = await runCli(['run', 'research_agent', 'go', '--json']);
    expect(exitCode === null || exitCode === 0).toBe(true);

    const lines = stdout.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(events.length);
    const parsed = lines.map((l) => JSON.parse(l) as RunEvent);
    expect(parsed).toEqual(events);
  });

  it('exits non-zero with an error message when the agent id is unknown', async () => {
    registerProvider('claude_code_local', () => new FakeProvider({ events: [] }));

    const { stderr, exitCode } = await runCli(['run', 'no_such_agent', 'goal']);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/agent "no_such_agent" not found/);
  });

  it('exits 130 when the scripted run ends with reason "cancelled"', async () => {
    const events = scriptedTranscript()
      .message('assistant', 'aborting')
      .done({ reason: 'cancelled', durationMs: 5 })
      .build();
    registerProvider('claude_code_local', () => new FakeProvider({ events }));

    const { exitCode, stdout } = await runCli(['run', 'research_agent', '--no-color', 'goal']);
    expect(exitCode).toBe(130);
    expect(stdout).toContain('— done (cancelled)');
  });

  it('exits 1 when the scripted run ends with reason "error"', async () => {
    const events = scriptedTranscript()
      .error('boom')
      .done({ reason: 'error', durationMs: 2 })
      .build();
    registerProvider('claude_code_local', () => new FakeProvider({ events }));

    const { exitCode, stdout } = await runCli(['run', 'research_agent', '--no-color', 'goal']);
    expect(exitCode).toBe(1);
    expect(stdout).toContain('error: boom');
    expect(stdout).toContain('— done (error)');
  });

  it('--model flag overrides the agent frontmatter model', async () => {
    const events = scriptedTranscript().done({ reason: 'completed' }).build();
    const spy = makeSpyProvider(events);
    registerProvider('claude_code_local', () => spy);

    const { exitCode } = await runCli(['run', 'research_agent', 'goal', '--model', 'sonnet-test']);
    expect(exitCode === null || exitCode === 0).toBe(true);
    expect(spy.inputs[0]!.model).toBe('sonnet-test');
  });

  it('falls back to the agent frontmatter model when --model is not set', async () => {
    const events = scriptedTranscript().done({ reason: 'completed' }).build();
    const spy = makeSpyProvider(events);
    registerProvider('claude_code_local', () => spy);

    const { exitCode } = await runCli(['run', 'research_agent', 'goal']);
    expect(exitCode === null || exitCode === 0).toBe(true);
    // research_agent.md declares `model: opus`.
    expect(spy.inputs[0]!.model).toBe('opus');
  });

  it('--no-mcp passes mcpServers: {} to the provider', async () => {
    const events = scriptedTranscript().done({ reason: 'completed' }).build();
    const spy = makeSpyProvider(events);
    registerProvider('claude_code_local', () => spy);

    const { exitCode } = await runCli(['run', 'research_agent', 'goal', '--no-mcp']);
    expect(exitCode === null || exitCode === 0).toBe(true);
    expect(spy.inputs[0]!.mcpServers).toEqual({});
  });

  it('leaves mcpServers undefined by default so the provider loads .mcp.json', async () => {
    const events = scriptedTranscript().done({ reason: 'completed' }).build();
    const spy = makeSpyProvider(events);
    registerProvider('claude_code_local', () => spy);

    const { exitCode } = await runCli(['run', 'research_agent', 'goal']);
    expect(exitCode === null || exitCode === 0).toBe(true);
    expect(spy.inputs[0]!.mcpServers).toBeUndefined();
  });
});

describe('buildRunCommand wiring', () => {
  it('exposes a `run` command on the top-level program', () => {
    const program = buildProgram();
    const runCmd = program.commands.find((c) => c.name() === 'run');
    expect(runCmd).toBeDefined();
  });
});
