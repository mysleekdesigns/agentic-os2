import { describe, expect, it } from 'vitest';
import { AgentFrontmatterSchema } from '../../../src/core/agents/schema.js';

const valid = {
  id: 'research_agent',
  name: 'Research Agent',
  version: 1,
  role: 'Deep web and repository researcher',
  provider: 'claude_code_local',
  model: 'opus',
  tools: {
    allowed: ['fs.read'],
    approval_required: ['fs.write'],
  },
  permissions: {
    network: 'approval_required',
    file_read: 'allow',
    file_write: 'approval_required',
    shell: 'deny',
  },
  memory: { read: ['project'], write: ['research_notes'] },
};

describe('AgentFrontmatterSchema', () => {
  it('accepts a complete valid frontmatter', () => {
    const parsed = AgentFrontmatterSchema.parse(valid);
    expect(parsed.id).toBe('research_agent');
    expect(parsed.tools.allowed).toEqual(['fs.read']);
  });

  it('applies array defaults for optional list fields', () => {
    const minimal = {
      id: 'a',
      name: 'A',
      version: 1,
      role: 'R',
      provider: 'p',
      permissions: {
        network: 'allow',
        file_read: 'allow',
        file_write: 'allow',
        shell: 'allow',
      },
    };
    const parsed = AgentFrontmatterSchema.parse(minimal);
    expect(parsed.tools.allowed).toEqual([]);
    expect(parsed.tools.approval_required).toEqual([]);
    expect(parsed.memory.read).toEqual([]);
    expect(parsed.memory.write).toEqual([]);
    expect(parsed.model).toBeUndefined();
    expect(parsed.eval).toBeUndefined();
  });

  it('rejects missing id', () => {
    const bad = { ...valid } as Record<string, unknown>;
    delete bad.id;
    expect(() => AgentFrontmatterSchema.parse(bad)).toThrow();
  });

  it('rejects ids with path-traversal or invalid characters', () => {
    for (const id of ['../foo', 'foo/bar', 'foo bar', 'Foo', '-leading-dash', '']) {
      expect(() => AgentFrontmatterSchema.parse({ ...valid, id })).toThrow();
    }
  });

  it('rejects a bad permissions enum value', () => {
    const bad = {
      ...valid,
      permissions: { ...valid.permissions, network: 'maybe' },
    };
    expect(() => AgentFrontmatterSchema.parse(bad)).toThrow();
  });

  it('rejects a non-array tools.allowed', () => {
    const bad = {
      ...valid,
      tools: { allowed: 'fs.read', approval_required: [] },
    };
    expect(() => AgentFrontmatterSchema.parse(bad)).toThrow();
  });

  it('rejects negative or zero version', () => {
    expect(() => AgentFrontmatterSchema.parse({ ...valid, version: -1 })).toThrow();
    expect(() => AgentFrontmatterSchema.parse({ ...valid, version: 0 })).toThrow();
    expect(() => AgentFrontmatterSchema.parse({ ...valid, version: 1.5 })).toThrow();
  });

  it('accepts an optional eval block', () => {
    const parsed = AgentFrontmatterSchema.parse({
      ...valid,
      eval: {
        fixtures: 'evals/fixtures/research/*.yaml',
        success_criteria: ['cites credible sources'],
      },
    });
    expect(parsed.eval?.success_criteria).toEqual(['cites credible sources']);
  });
});
