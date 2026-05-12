import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The hook lives at `<repoRoot>/.claude/hooks/mcp-policy.sh`. We drive it as a
// child process with crafted stdin, asserting exit codes and stderr text. Each
// test uses its own tmpdir as the fake CLAUDE_PROJECT_DIR — we never touch the
// real `.mcp.json` (which is known to contain real-looking secrets).

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const HOOK_PATH = join(REPO_ROOT, '.claude', 'hooks', 'mcp-policy.sh');

interface HookResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runHook(input: unknown, projectDir: string): Promise<HookResult> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn('bash', [HOOK_PATH], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (b) => {
      stdout += String(b);
    });
    proc.stderr.on('data', (b) => {
      stderr += String(b);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });

    proc.stdin.end(JSON.stringify(input));
  });
}

let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'agent-os-hook-'));
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

describe('mcp-policy.sh', () => {
  it('exits 0 silently for non-MCP tools', async () => {
    const res = await runHook({ tool_name: 'Read', tool_input: { path: 'a.txt' } }, projectDir);
    expect(res.code).toBe(0);
    expect(res.stderr).toBe('');
  });

  it('exits 0 silently when .mcp.json is missing', async () => {
    const res = await runHook({ tool_name: 'mcp__filesystem__list', tool_input: {} }, projectDir);
    expect(res.code).toBe(0);
    expect(res.stderr).toBe('');
  });

  it('blocks with exit 2 when the server is not in .mcp.json', async () => {
    await writeFile(
      join(projectDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'node' } } }),
    );

    const res = await runHook({ tool_name: 'mcp__missing__doStuff', tool_input: {} }, projectDir);
    expect(res.code).toBe(2);
    expect(res.stderr).toMatch(/'missing' not declared in \.mcp\.json/);
  });

  it('blocks with exit 2 under pinned mode when the entry has no command_sha256', async () => {
    await writeFile(
      join(projectDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { fs: { command: 'node', args: ['s.js'] } } }),
    );
    await writeFile(
      join(projectDir, 'agent-os.config.yaml'),
      'security:\n  pinned_mcp_servers: true\n',
    );

    const res = await runHook({ tool_name: 'mcp__fs__readFile', tool_input: {} }, projectDir);
    expect(res.code).toBe(2);
    expect(res.stderr).toMatch(/no command_sha256/);
  });

  it('allows when pinned mode is on and the checksum matches the file on disk', async () => {
    const binPath = join(projectDir, 'srv.js');
    const body = 'server body\n';
    await writeFile(binPath, body);
    const digest = createHash('sha256').update(body).digest('hex');

    await writeFile(
      join(projectDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: { fs: { command: binPath, command_sha256: digest } },
      }),
    );
    await writeFile(
      join(projectDir, 'agent-os.config.yaml'),
      'security:\n  pinned_mcp_servers: true\n',
    );

    const res = await runHook({ tool_name: 'mcp__fs__readFile', tool_input: {} }, projectDir);
    expect(res.code).toBe(0);
    expect(res.stderr).toBe('');
  });

  it('blocks when the checksum is declared but the file digest disagrees', async () => {
    const binPath = join(projectDir, 'srv.js');
    await writeFile(binPath, 'actual body');
    const wrongDigest = 'c'.repeat(64);

    await writeFile(
      join(projectDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: { fs: { command: binPath, command_sha256: wrongDigest } },
      }),
    );
    await writeFile(
      join(projectDir, 'agent-os.config.yaml'),
      'security:\n  pinned_mcp_servers: true\n',
    );

    const res = await runHook({ tool_name: 'mcp__fs__readFile', tool_input: {} }, projectDir);
    expect(res.code).toBe(2);
    expect(res.stderr).toMatch(/checksum mismatch/);
  });

  it('parses server name correctly when the server contains underscores', async () => {
    // Regression: an earlier server-name parser used `[^_]+` which rejected
    // any server containing `_` and silently exited 0 — a hook bypass for an
    // entire class of names (e.g. `mcp__claude_ai_Gmail__authenticate`). The
    // hook must extract `claude_ai_Gmail` and then block when that server is
    // not declared in `.mcp.json`.
    await writeFile(
      join(projectDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'node' } } }),
    );

    const res = await runHook(
      { tool_name: 'mcp__claude_ai_Gmail__authenticate', tool_input: {} },
      projectDir,
    );
    expect(res.code).toBe(2);
    expect(res.stderr).toMatch(/'claude_ai_Gmail' not declared in \.mcp\.json/);
  });

  it('allows when pinning is off and the entry has no checksum', async () => {
    await writeFile(
      join(projectDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { fs: { command: 'node' } } }),
    );
    // No agent-os.config.yaml → unpinned by default.

    const res = await runHook({ tool_name: 'mcp__fs__readFile', tool_input: {} }, projectDir);
    expect(res.code).toBe(0);
    expect(res.stderr).toBe('');
  });
});
