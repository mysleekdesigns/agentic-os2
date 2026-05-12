import { describe, expect, it } from 'vitest';
import { createToolRegistry } from '../../../src/core/tools/registry.js';
import { BUILTIN_TOOL_RISKS } from '../../../src/core/tools/risk.js';

describe('createToolRegistry', () => {
  it('seeds with every built-in tool', () => {
    const reg = createToolRegistry();
    for (const id of Object.keys(BUILTIN_TOOL_RISKS)) {
      expect(reg.has(id)).toBe(true);
      expect(reg.get(id)?.risk).toBe(BUILTIN_TOOL_RISKS[id]);
    }
  });

  it('list() returns every built-in', () => {
    const reg = createToolRegistry();
    const ids = reg.list().map((d) => d.id);
    expect(ids).toEqual(expect.arrayContaining(Object.keys(BUILTIN_TOOL_RISKS)));
  });

  it('register() adds a new tool', () => {
    const reg = createToolRegistry();
    reg.register({ id: 'mcp__custom__do_thing', risk: 'network', description: 'custom' });
    expect(reg.has('mcp__custom__do_thing')).toBe(true);
    expect(reg.get('mcp__custom__do_thing')).toEqual({
      id: 'mcp__custom__do_thing',
      risk: 'network',
      description: 'custom',
    });
  });

  it('register() is last-write-wins for duplicate ids', () => {
    const reg = createToolRegistry();
    reg.register({ id: 'Read', risk: 'shell' });
    expect(reg.get('Read')?.risk).toBe('shell');
    reg.register({ id: 'Read', risk: 'read' });
    expect(reg.get('Read')?.risk).toBe('read');
  });

  it('get() returns undefined for missing ids', () => {
    const reg = createToolRegistry();
    expect(reg.get('not-registered')).toBeUndefined();
  });

  it('has() reports false for missing ids', () => {
    const reg = createToolRegistry();
    expect(reg.has('not-registered')).toBe(false);
  });

  it('riskFor() uses the registered descriptor', () => {
    const reg = createToolRegistry();
    reg.register({ id: 'custom_tool', risk: 'destructive' });
    expect(reg.riskFor('custom_tool')).toBe('destructive');
  });

  it('riskFor() falls through to classifyTool for unregistered MCP ids', () => {
    const reg = createToolRegistry();
    expect(reg.riskFor('mcp__crawlforge__fetch_url')).toBe('network');
    expect(reg.riskFor('mcp__github__create_issue')).toBe('write');
  });

  it('riskFor() falls through to classifyTool default (read) for unknown ids', () => {
    const reg = createToolRegistry();
    expect(reg.riskFor('totally-unknown-tool')).toBe('read');
  });

  it('get() returns a copy so callers cannot mutate the registry entry', () => {
    const reg = createToolRegistry();
    const a = reg.get('Read');
    if (a) {
      a.risk = 'destructive';
    }
    expect(reg.get('Read')?.risk).toBe('read');
  });
});
