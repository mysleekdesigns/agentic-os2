/**
 * `.mcp.json` loader for the `claude_code_local` provider (PRD §2.7, Phase 3).
 *
 * Reads the workspace-scope MCP server map and coerces it into the shape the
 * Claude Agent SDK expects (passthrough of `command`, `args`, `env`). The file
 * is OPTIONAL — Phase 3 ships with or without MCP configured — so any read or
 * parse failure degrades to an empty record with a single-line warning on
 * stderr.
 *
 * Entries with an empty `command` are dropped: an MCP entry with no executable
 * cannot start a server, and forwarding it would make the SDK emit an opaque
 * spawn error far from this call site.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { McpServerConfig } from '../../core/providers/index.js';

/** Read `<workspaceRoot>/.mcp.json` and return its `mcpServers` map. */
export async function loadMcpServers(
  workspaceRoot: string,
): Promise<Record<string, McpServerConfig>> {
  const filePath = resolve(workspaceRoot, '.mcp.json');

  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    // Missing file is the common case (no MCP servers configured) — silent.
    if (isEnoent(err)) return {};
    process.stderr.write(
      `agent-os: .mcp.json read failed (${describe(err)}); proceeding without MCP\n`,
    );
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(
      `agent-os: .mcp.json parse failed (${describe(err)}); proceeding without MCP\n`,
    );
    return {};
  }

  if (parsed === null || typeof parsed !== 'object') return {};

  const root = parsed as Record<string, unknown>;
  const serversField = root.mcpServers;
  if (serversField === undefined || serversField === null || typeof serversField !== 'object') {
    return {};
  }

  const out: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(serversField as Record<string, unknown>)) {
    const coerced = coerceServer(value);
    if (coerced === null) continue;
    out[name] = coerced;
  }
  return out;
}

function coerceServer(value: unknown): McpServerConfig | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.command !== 'string' || v.command.length === 0) return null;

  const out: McpServerConfig = { command: v.command };

  if (Array.isArray(v.args)) {
    const args = v.args.filter((a): a is string => typeof a === 'string');
    if (args.length > 0) out.args = args;
  }

  if (v.env !== null && typeof v.env === 'object') {
    const env: Record<string, string> = {};
    for (const [k, ev] of Object.entries(v.env as Record<string, unknown>)) {
      if (typeof ev === 'string') env[k] = ev;
    }
    if (Object.keys(env).length > 0) out.env = env;
  }

  return out;
}

function isEnoent(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
