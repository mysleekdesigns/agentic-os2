import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import yaml from 'js-yaml';

import { buildProgram } from '../../src/cli/index.js';
import { runInit } from '../../src/cli/commands/init.js';
import { AgentFrontmatterSchema } from '../../src/core/agents/schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface NewJsonResult {
  id: string;
  path: string;
  mirrorPath: string;
  fixturePath: string;
}

/**
 * Drive a single Commander invocation, capturing stdout/stderr and the exit
 * code passed to a mocked `process.exit`.
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
  } catch {
    // Expected control-flow from mocked exit / Commander exitOverride.
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

/** Copy the canonical research_agent template into the tmp workspace. */
function copyResearchAgentTemplate(tmpDir: string): void {
  const src = resolve(__dirname, '..', '..', 'agents', 'templates', 'research_agent.md');
  const destDir = join(tmpDir, 'agents', 'templates');
  mkdirSync(destDir, { recursive: true });
  copyFileSync(src, join(destDir, 'research_agent.md'));
}

/** Read and parse the YAML frontmatter from `path`, throwing on malformed input. */
function readFrontmatter(path: string): unknown {
  const text = readFileSync(path, 'utf8');
  const openMatch = /^---\s*\r?\n/.exec(text);
  if (!openMatch) throw new Error('missing opening frontmatter');
  const afterOpen = text.slice(openMatch[0].length);
  const closeMatch = /\n---\s*(\r?\n|$)/.exec(afterOpen);
  if (!closeMatch) throw new Error('missing closing frontmatter');
  return yaml.load(afterOpen.slice(0, closeMatch.index));
}

describe('agent-os agent new', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agent-os-agent-new-'));
    runInit({ cwd: tmpDir });
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates canonical, mirror, and fixture files; frontmatter parses via schema', async () => {
    const { exitCode } = await runCli(['agent', 'new', 'my_bot']);
    expect(exitCode === null || exitCode === 0).toBe(true);

    const canonical = join(tmpDir, 'agents', 'my_bot.md');
    const mirror = join(tmpDir, '.claude', 'agents', 'my_bot.md');
    const fixture = join(tmpDir, 'evals', 'fixtures', 'my_bot', 'smoke.yaml');

    expect(existsSync(canonical)).toBe(true);
    expect(existsSync(mirror)).toBe(true);
    expect(existsSync(fixture)).toBe(true);

    const parsedFm = readFrontmatter(canonical);
    const result = AgentFrontmatterSchema.safeParse(parsedFm);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe('my_bot');
      expect(result.data.name).toBe('My Bot');
      expect(result.data.provider).toBe('claude_code_local');
    }

    const fixtureText = readFileSync(fixture, 'utf8');
    expect(fixtureText).toContain('agent-os:my_bot');
    expect(fixtureText).toContain('icontains');
  });

  it('--from research_agent copies the template frontmatter shape with the new id', async () => {
    copyResearchAgentTemplate(tmpDir);

    const { exitCode } = await runCli(['agent', 'new', 'my_bot', '--from', 'research_agent']);
    expect(exitCode === null || exitCode === 0).toBe(true);

    const canonical = join(tmpDir, 'agents', 'my_bot.md');
    expect(existsSync(canonical)).toBe(true);

    const parsedFm = readFrontmatter(canonical) as Record<string, unknown>;
    expect(parsedFm.id).toBe('my_bot');
    expect(parsedFm.name).toBe('My Bot');
    // Template-specific frontmatter fields should be preserved.
    const tools = parsedFm.tools as { allowed: string[]; approval_required: string[] };
    expect(tools.allowed).toContain('mcp.crawlforge.search_web');
    // eval.fixtures should have been rewritten to point at the new id.
    const evalBlock = parsedFm.eval as { fixtures: string };
    expect(evalBlock.fixtures).toBe('evals/fixtures/my_bot/*.yaml');
  });

  it('rejects an invalid id with exit 1 and a useful stderr', async () => {
    const { stderr, exitCode } = await runCli(['agent', 'new', 'BAD-ID']);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/invalid id/i);
  });

  it('refuses to overwrite without --force; succeeds with --force', async () => {
    const first = await runCli(['agent', 'new', 'my_bot']);
    expect(first.exitCode === null || first.exitCode === 0).toBe(true);

    const second = await runCli(['agent', 'new', 'my_bot']);
    expect(second.exitCode).toBe(1);
    expect(second.stderr).toMatch(/already exists/i);

    const third = await runCli(['agent', 'new', 'my_bot', '--force']);
    expect(third.exitCode === null || third.exitCode === 0).toBe(true);
  });

  it('--json prints a parseable object with the four expected fields', async () => {
    const { stdout, exitCode } = await runCli(['agent', 'new', 'my_bot', '--json']);
    expect(exitCode === null || exitCode === 0).toBe(true);

    const trimmed = stdout.trim();
    const parsed = JSON.parse(trimmed) as NewJsonResult;
    expect(parsed.id).toBe('my_bot');
    expect(parsed.path.endsWith(join('agents', 'my_bot.md'))).toBe(true);
    expect(parsed.mirrorPath.endsWith(join('.claude', 'agents', 'my_bot.md'))).toBe(true);
    expect(parsed.fixturePath.endsWith(join('evals', 'fixtures', 'my_bot', 'smoke.yaml'))).toBe(
      true,
    );
  });
});

describe('buildAgentCommand wiring (with `new`)', () => {
  it('exposes `new` as a subcommand of `agent`', () => {
    const program = buildProgram();
    const agentCmd = program.commands.find((c) => c.name() === 'agent');
    expect(agentCmd).toBeDefined();
    const subs = agentCmd!.commands.map((c) => c.name());
    expect(subs).toContain('new');
  });
});
