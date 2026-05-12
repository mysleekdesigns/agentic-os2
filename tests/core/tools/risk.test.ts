import { describe, expect, it } from 'vitest';
import { BUILTIN_TOOL_RISKS, classifyTool, type RiskTag } from '../../../src/core/tools/risk.js';

describe('BUILTIN_TOOL_RISKS', () => {
  it('covers all five risk tags with at least two tools each', () => {
    const byRisk: Record<RiskTag, string[]> = {
      read: [],
      write: [],
      network: [],
      shell: [],
      destructive: [],
    };
    for (const [id, risk] of Object.entries(BUILTIN_TOOL_RISKS)) {
      byRisk[risk].push(id);
    }
    expect(byRisk.read.length).toBeGreaterThanOrEqual(2);
    expect(byRisk.write.length).toBeGreaterThanOrEqual(2);
    expect(byRisk.network.length).toBeGreaterThanOrEqual(2);
    expect(byRisk.shell.length).toBeGreaterThanOrEqual(2);
    expect(byRisk.destructive.length).toBeGreaterThanOrEqual(2);
  });
});

describe('classifyTool — built-ins', () => {
  it.each([
    ['fs.read', 'read'],
    ['Read', 'read'],
    ['Glob', 'read'],
    ['Grep', 'read'],
    ['LS', 'read'],
  ] as const)('classifies %s as read', (tool, expected) => {
    expect(classifyTool(tool)).toBe(expected);
  });

  it.each([
    ['fs.write', 'write'],
    ['Edit', 'write'],
    ['Write', 'write'],
    ['NotebookEdit', 'write'],
  ] as const)('classifies %s as write', (tool, expected) => {
    expect(classifyTool(tool)).toBe(expected);
  });

  it.each([
    ['WebFetch', 'network'],
    ['WebSearch', 'network'],
    ['network.fetch', 'network'],
  ] as const)('classifies %s as network', (tool, expected) => {
    expect(classifyTool(tool)).toBe(expected);
  });

  it.each([
    ['Bash', 'shell'],
    ['shell.exec', 'shell'],
  ] as const)('classifies %s as shell', (tool, expected) => {
    expect(classifyTool(tool)).toBe(expected);
  });

  it.each([
    ['fs.delete', 'destructive'],
    ['fs.rm', 'destructive'],
    ['destructive.rm', 'destructive'],
  ] as const)('classifies %s as destructive', (tool, expected) => {
    expect(classifyTool(tool)).toBe(expected);
  });
});

describe('classifyTool — MCP heuristic', () => {
  it('treats mcp__server__tool fetch-ish names as network', () => {
    expect(classifyTool('mcp__crawlforge__fetch_url')).toBe('network');
    expect(classifyTool('mcp__crawlforge__search_web')).toBe('network');
  });

  it('upgrades mcp__server__tool to write when suffix matches a write verb', () => {
    expect(classifyTool('mcp__github__create_issue')).toBe('write');
    expect(classifyTool('mcp__github__update_pr')).toBe('write');
    expect(classifyTool('mcp__mail__send_message')).toBe('write');
    expect(classifyTool('mcp__svc__delete_thing')).toBe('write');
  });

  it('classifies underscored server names correctly (server contains _)', () => {
    // Claude Code MCP convention: `mcp__<server>__<tool>` where `<server>` may
    // itself contain single underscores. The regex must use the literal `__`
    // as the separator, not bail on the first underscore.
    expect(classifyTool('mcp__claude_ai_Gmail__authenticate')).toBe('network');
    expect(classifyTool('mcp__google_drive__list_files')).toBe('network');
    expect(classifyTool('mcp__google_drive__delete_file')).toBe('write');
    expect(classifyTool('mcp__claude_ai_Calendar__create_event')).toBe('write');
  });

  it('honors the dot-namespaced MCP form', () => {
    expect(classifyTool('mcp.crawlforge.search_web')).toBe('network');
    expect(classifyTool('mcp.github.create_pr')).toBe('write');
  });

  it('does not match malformed MCP-looking ids', () => {
    // single underscores -> falls through to unknownDefault
    expect(classifyTool('mcp_crawlforge_fetch', { unknownDefault: 'read' })).toBe('read');
  });
});

describe('classifyTool — overrides and unknownDefault', () => {
  it('override map wins over built-ins', () => {
    expect(classifyTool('Read', { overrides: { Read: 'destructive' } })).toBe('destructive');
  });

  it('override map wins over MCP heuristic', () => {
    expect(
      classifyTool('mcp__github__create_issue', {
        overrides: { mcp__github__create_issue: 'read' },
      }),
    ).toBe('read');
  });

  it('honors unknownDefault when nothing matches', () => {
    expect(classifyTool('totally-unknown-tool', { unknownDefault: 'shell' })).toBe('shell');
  });

  it('falls back to read when no unknownDefault is supplied', () => {
    expect(classifyTool('totally-unknown-tool')).toBe('read');
  });
});
