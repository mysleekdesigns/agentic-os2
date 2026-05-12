import { createHash } from 'node:crypto';
import { chmod, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  computeCommandSha256,
  loadMcpServers,
  verifyServer,
} from '../../../src/providers/claude_code_local/mcp.js';

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'agent-os-mcp-'));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function sha256OfBuffer(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

describe('loadMcpServers', () => {
  it('returns {} when .mcp.json is missing', async () => {
    const out = await loadMcpServers(workspace);
    expect(out).toEqual({});
  });

  it('parses a typical .mcp.json and passes command/args/env through', async () => {
    await writeFile(
      join(workspace, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          crawlforge: {
            command: 'npx',
            args: ['-y', '@crawlforge/mcp'],
            env: { CRAWLFORGE_API_KEY: 'shhh' },
          },
          filesystem: {
            command: 'node',
            args: ['./fs-server.js'],
          },
        },
      }),
    );

    const out = await loadMcpServers(workspace);
    expect(out).toEqual({
      crawlforge: {
        command: 'npx',
        args: ['-y', '@crawlforge/mcp'],
        env: { CRAWLFORGE_API_KEY: 'shhh' },
      },
      filesystem: {
        command: 'node',
        args: ['./fs-server.js'],
      },
    });
  });

  it('drops entries whose command is empty or non-string', async () => {
    await writeFile(
      join(workspace, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          good: { command: 'node', args: ['x'] },
          empty: { command: '' },
          nope: { args: ['nothing'] },
          wrong: { command: 42 },
        },
      }),
    );

    const out = await loadMcpServers(workspace);
    expect(Object.keys(out)).toEqual(['good']);
  });

  it('returns {} and warns on stderr when .mcp.json is malformed', async () => {
    await writeFile(join(workspace, '.mcp.json'), '{ not json');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const out = await loadMcpServers(workspace);
    expect(out).toEqual({});
    expect(stderr).toHaveBeenCalledTimes(1);
    const [arg] = stderr.mock.calls[0] ?? [];
    expect(String(arg)).toMatch(/\.mcp\.json parse failed/);

    stderr.mockRestore();
  });

  it('tolerates a file with no mcpServers field', async () => {
    await writeFile(join(workspace, '.mcp.json'), JSON.stringify({ otherKey: 1 }));
    const out = await loadMcpServers(workspace);
    expect(out).toEqual({});
  });

  it('keeps a server whose command_sha256 matches the on-disk file', async () => {
    const binPath = join(workspace, 'fake-server.js');
    const body = 'console.log("hi");\n';
    await writeFile(binPath, body);
    const digest = sha256OfBuffer(Buffer.from(body));

    await writeFile(
      join(workspace, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          pinned: { command: binPath, command_sha256: digest },
        },
      }),
    );

    const out = await loadMcpServers(workspace, { pinned: true });
    expect(out).toEqual({ pinned: { command: binPath } });
  });

  it('drops a server whose command_sha256 mismatches and warns on stderr', async () => {
    const binPath = join(workspace, 'tampered.js');
    await writeFile(binPath, 'actual content');
    const wrong = 'a'.repeat(64);

    await writeFile(
      join(workspace, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          bad: { command: binPath, command_sha256: wrong },
        },
      }),
    );

    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const out = await loadMcpServers(workspace, { pinned: true });
    expect(out).toEqual({});
    const stderrText = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrText).toMatch(/checksum mismatch for "bad"/);
    expect(stderrText).toMatch(/expected /);
    expect(stderrText).toMatch(/got /);

    stderr.mockRestore();
  });

  it('pinned=true drops entries without command_sha256 and warns', async () => {
    await writeFile(
      join(workspace, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          unpinned: { command: 'node', args: ['x'] },
        },
      }),
    );

    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const out = await loadMcpServers(workspace, { pinned: true });
    expect(out).toEqual({});
    const stderrText = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrText).toMatch(/has no command_sha256/);
    expect(stderrText).toMatch(/pinned_mcp_servers=true/);

    stderr.mockRestore();
  });

  it('pinned=false keeps entries without command_sha256', async () => {
    await writeFile(
      join(workspace, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          unpinned: { command: 'node', args: ['x'] },
        },
      }),
    );

    const out = await loadMcpServers(workspace, { pinned: false });
    expect(out).toEqual({ unpinned: { command: 'node', args: ['x'] } });
  });

  it('verifies a checksum for a bare-token command via fallback hash', async () => {
    const digestOfNode = sha256OfBuffer('node');

    await writeFile(
      join(workspace, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          bare: { command: 'node', command_sha256: digestOfNode },
        },
      }),
    );

    // We can't predict that `node` does not resolve to a file on disk in the
    // test environment, so use a clearly-non-file token instead.
    const wackToken = 'definitely-not-a-real-binary-token';
    const digestOfToken = sha256OfBuffer(wackToken);

    await writeFile(
      join(workspace, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          bare: { command: wackToken, command_sha256: digestOfToken },
        },
      }),
    );

    const out = await loadMcpServers(workspace, { pinned: true });
    expect(out).toEqual({ bare: { command: wackToken } });
  });

  it('drops an entry whose command_sha256 is not 64-hex', async () => {
    await writeFile(
      join(workspace, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          bad: { command: 'node', command_sha256: 'not-hex-and-too-short' },
        },
      }),
    );

    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const out = await loadMcpServers(workspace, { pinned: false });
    expect(out).toEqual({});
    const stderrText = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrText).toMatch(/checksum mismatch for "bad"/);
    stderr.mockRestore();
  });
});

describe('computeCommandSha256', () => {
  it('hashes file contents when the command path resolves to a regular file', async () => {
    const path = join(workspace, 'bin.js');
    const body = 'export const x = 1;\n';
    await writeFile(path, body);
    await chmod(path, 0o755);

    expect(await computeCommandSha256(path)).toBe(sha256OfBuffer(Buffer.from(body)));
  });

  it('falls back to hashing the literal command string when no file exists', async () => {
    const token = 'totally-not-a-real-binary-anywhere-on-PATH';
    expect(await computeCommandSha256(token)).toBe(sha256OfBuffer(token));
  });
});

describe('verifyServer', () => {
  it('ok=true when no checksum is declared and pinning is off', async () => {
    expect(await verifyServer({ command: 'node' }, { pinned: false })).toEqual({ ok: true });
  });

  it('ok=false when no checksum is declared and pinning is on', async () => {
    const result = await verifyServer({ command: 'node' }, { pinned: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/missing command_sha256/);
  });

  it('ok=false when checksum is not 64-hex', async () => {
    const result = await verifyServer(
      { command: 'node', command_sha256: 'oops' },
      { pinned: true },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/64-hex/);
  });

  it('ok=true when checksum matches a file on disk', async () => {
    const path = join(workspace, 'srv.js');
    const body = 'srv\n';
    await writeFile(path, body);
    const digest = sha256OfBuffer(Buffer.from(body));

    expect(await verifyServer({ command: path, command_sha256: digest }, { pinned: true })).toEqual(
      { ok: true },
    );
  });

  it('ok=false with reason when checksum mismatches', async () => {
    const path = join(workspace, 'srv.js');
    await writeFile(path, 'something');
    const result = await verifyServer(
      { command: path, command_sha256: 'b'.repeat(64) },
      { pinned: true },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/expected /);
      expect(result.reason).toMatch(/got /);
    }
  });
});
