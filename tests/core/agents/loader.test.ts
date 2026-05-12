import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadAgent, loadAgents, AgentLoadError } from '../../../src/core/agents/loader.js';

function fixture(overrides: Partial<{ id: string; version: number; body: string }> = {}) {
  const id = overrides.id ?? 'research_agent';
  const version = overrides.version ?? 1;
  const body = overrides.body ?? '# Instructions\n\nDo the research.\n';
  return `---
id: ${id}
name: Research Agent
version: ${version}
role: Deep web and repository researcher
provider: claude_code_local
model: opus
tools:
  allowed:
    - fs.read
  approval_required:
    - fs.write
permissions:
  network: approval_required
  file_read: allow
  file_write: approval_required
  shell: deny
memory:
  read: [project]
  write: [research_notes]
---
${body}`;
}

describe('loadAgent / loadAgents', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-os-loader-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads a single file and returns body + hash', async () => {
    const file = join(dir, 'a.md');
    const text = fixture();
    await writeFile(file, text, 'utf8');

    const def = await loadAgent(file);
    expect(def.frontmatter.id).toBe('research_agent');
    expect(def.frontmatter.tools.allowed).toEqual(['fs.read']);
    expect(def.body).toBe('# Instructions\n\nDo the research.\n');
    expect(def.path).toBe(resolve(file));
    expect(def.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces a stable hash that changes when content changes', async () => {
    const fileA = join(dir, 'a.md');
    await writeFile(fileA, fixture(), 'utf8');
    const a1 = await loadAgent(fileA);
    const a2 = await loadAgent(fileA);
    expect(a1.hash).toBe(a2.hash);

    await writeFile(fileA, fixture({ body: '# Changed\n' }), 'utf8');
    const a3 = await loadAgent(fileA);
    expect(a3.hash).not.toBe(a1.hash);
  });

  it('walks directories and excludes templates/ and examples/', async () => {
    await writeFile(join(dir, 'one.md'), fixture({ id: 'one' }), 'utf8');
    await mkdir(join(dir, 'nested'), { recursive: true });
    await writeFile(join(dir, 'nested', 'two.md'), fixture({ id: 'two' }), 'utf8');

    await mkdir(join(dir, 'templates'), { recursive: true });
    await writeFile(join(dir, 'templates', 'starter.md'), fixture({ id: 'starter' }), 'utf8');

    await mkdir(join(dir, 'examples'), { recursive: true });
    await writeFile(join(dir, 'examples', 'demo.md'), fixture({ id: 'demo' }), 'utf8');

    const defs = await loadAgents(dir);
    const ids = defs.map((d) => d.frontmatter.id).sort();
    expect(ids).toEqual(['one', 'two']);
  });

  it('returns an empty array when the directory does not exist', async () => {
    const defs = await loadAgents(join(dir, 'does-not-exist'));
    expect(defs).toEqual([]);
  });

  it('throws on duplicate id and names both paths', async () => {
    const aFile = join(dir, 'a.md');
    const bFile = join(dir, 'b.md');
    await writeFile(aFile, fixture({ id: 'same' }), 'utf8');
    await writeFile(bFile, fixture({ id: 'same' }), 'utf8');

    await expect(loadAgents(dir)).rejects.toThrow(/duplicate agent id "same"/);
  });

  it('throws AgentLoadError on malformed YAML', async () => {
    const file = join(dir, 'bad.md');
    await writeFile(file, '---\nid: [unterminated\n---\nbody\n', 'utf8');
    await expect(loadAgent(file)).rejects.toBeInstanceOf(AgentLoadError);
    await expect(loadAgent(file)).rejects.toThrow(/invalid YAML/);
  });

  it('throws AgentLoadError when frontmatter is missing entirely', async () => {
    const file = join(dir, 'plain.md');
    await writeFile(file, '# just markdown, no frontmatter\n', 'utf8');
    await expect(loadAgent(file)).rejects.toBeInstanceOf(AgentLoadError);
    await expect(loadAgent(file)).rejects.toThrow(/missing leading/);
  });

  it('throws AgentLoadError when the closing delimiter is missing', async () => {
    const file = join(dir, 'open.md');
    await writeFile(file, '---\nid: x\nname: X\nversion: 1\nrole: r\nprovider: p\n', 'utf8');
    await expect(loadAgent(file)).rejects.toThrow(/missing closing/);
  });

  it('surfaces Zod issue paths in the error message', async () => {
    const file = join(dir, 'invalid.md');
    await writeFile(
      file,
      `---
id: x
name: X
version: -1
role: r
provider: p
permissions:
  network: allow
  file_read: allow
  file_write: allow
  shell: allow
---
body
`,
      'utf8',
    );
    await expect(loadAgent(file)).rejects.toThrow(/version/);
  });
});
