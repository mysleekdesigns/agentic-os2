import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadMcpServers } from '../../../src/providers/claude_code_local/mcp.js';

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'agent-os-mcp-'));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

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
});
