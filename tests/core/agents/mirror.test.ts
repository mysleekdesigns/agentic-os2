import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mirrorToClaudeAgents } from '../../../src/core/agents/mirror.js';
import type { AgentDefinition } from '../../../src/core/agents/loader.js';

function def(id: string, role = `${id} role`): AgentDefinition {
  return {
    frontmatter: {
      id,
      name: id,
      version: 1,
      role,
      provider: 'claude_code_local',
      tools: { allowed: [], approval_required: [] },
      permissions: {
        network: 'allow',
        file_read: 'allow',
        file_write: 'allow',
        shell: 'allow',
      },
      memory: { read: [], write: [] },
    },
    body: '# Instructions\n\nbody for ' + id + '\n',
    path: `/tmp/agents/${id}.md`,
    hash: id.padEnd(64, '0'),
  };
}

describe('mirrorToClaudeAgents', () => {
  let mirrorDir: string;

  beforeEach(async () => {
    mirrorDir = await mkdtemp(join(tmpdir(), 'agent-os-mirror-'));
  });

  afterEach(async () => {
    await rm(mirrorDir, { recursive: true, force: true });
  });

  it('writes a mirror file with synthesized description', async () => {
    const result = await mirrorToClaudeAgents([def('research', 'do research')], mirrorDir);
    expect(result.written).toHaveLength(1);
    expect(result.removed).toEqual([]);

    const text = await readFile(join(mirrorDir, 'research.md'), 'utf8');
    expect(text).toMatch(/^---\n/);
    expect(text).toContain('id: research');
    expect(text).toContain('description: do research');
    expect(text).toContain('# Instructions');
  });

  it('preserves untouched non-Agent-OS subagent files', async () => {
    const native = join(mirrorDir, 'native.md');
    const nativeText = `---
name: native
description: a native claude code subagent
tools: Read, Grep
model: inherit
---
# native body
`;
    await writeFile(native, nativeText, 'utf8');

    await mirrorToClaudeAgents([def('research')], mirrorDir);

    const after = await readFile(native, 'utf8');
    expect(after).toBe(nativeText);

    const entries = await readdir(mirrorDir);
    expect(entries.sort()).toEqual(['native.md', 'research.md']);
  });

  it('removes orphaned Agent-OS-mirrored files', async () => {
    const first = await mirrorToClaudeAgents([def('one'), def('two')], mirrorDir);
    expect(first.written.map((p) => p.endsWith('one.md') || p.endsWith('two.md'))).toEqual([
      true,
      true,
    ]);

    const second = await mirrorToClaudeAgents([def('one')], mirrorDir);
    expect(second.removed).toHaveLength(1);
    expect(second.removed[0]).toMatch(/two\.md$/);
    expect(second.written).toHaveLength(1);

    const entries = await readdir(mirrorDir);
    expect(entries).toEqual(['one.md']);
  });

  it('is idempotent: re-running with same defs is a no-op on disk', async () => {
    await mirrorToClaudeAgents([def('one')], mirrorDir);
    const firstText = await readFile(join(mirrorDir, 'one.md'), 'utf8');
    const firstStat = (await import('node:fs/promises')).stat;
    const beforeMtime = (await firstStat(join(mirrorDir, 'one.md'))).mtimeMs;

    // Brief wait to ensure mtime would differ if rewritten.
    await new Promise((r) => setTimeout(r, 10));
    const second = await mirrorToClaudeAgents([def('one')], mirrorDir);
    const afterMtime = (await firstStat(join(mirrorDir, 'one.md'))).mtimeMs;

    expect(second.removed).toEqual([]);
    expect(await readFile(join(mirrorDir, 'one.md'), 'utf8')).toBe(firstText);
    expect(afterMtime).toBe(beforeMtime);
  });
});
