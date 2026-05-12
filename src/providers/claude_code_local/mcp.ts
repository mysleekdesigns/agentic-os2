/**
 * `.mcp.json` loader for the `claude_code_local` provider (PRD §2.7, §1.7,
 * Phase 3, Phase 4 Bundle C).
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
 *
 * Phase 4 — server pinning. Each entry may carry an optional
 * `command_sha256` (lowercase 64-hex) that the loader verifies against the
 * sha256 of the resolved command. When `security.pinned_mcp_servers: true`,
 * entries without a checksum are dropped with a stderr warning; entries with
 * a mismatched checksum are always dropped regardless of mode.
 *
 * Phase 3 invariant preserved: this module does NOT read
 * `ANTHROPIC_API_KEY` / `CLAUDE_API_KEY` / `OPENAI_API_KEY` from `process.env`.
 */

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { McpServerConfig } from '../../core/providers/index.js';

/** Lowercase 64-hex sha256 digest pattern. */
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** Options for {@link loadMcpServers}. */
export interface LoadMcpServersOptions {
  /**
   * Enforce `command_sha256` presence. When true, entries lacking a checksum
   * are dropped with a stderr warning. When false, missing checksums are
   * accepted but any checksum that IS present is still verified.
   * Defaults to `false` so call sites without a config remain permissive.
   */
  pinned?: boolean;
}

/**
 * Compute the sha256 digest used for pinning a server entry.
 *
 * Behavior (documented because it has a fallback):
 *
 * 1. If `command` resolves to an existing regular file on disk, hash the file
 *    CONTENTS. This is the strict mode — bit-for-bit identity of the binary
 *    or script the SDK will spawn.
 * 2. Otherwise (bare token like `node` / `python`, or path that does not exist
 *    yet) hash the UTF-8 bytes of the literal `command` string. This is the
 *    weak fallback — it still detects edits to `.mcp.json` but does NOT bind
 *    the entry to a specific binary on disk.
 *
 * The fallback is intentional: many real-world `.mcp.json` files use bare
 * interpreter names (`node`, `npx`, `python`), and refusing to pin them at all
 * would push users away from enabling `pinned_mcp_servers`.
 */
export async function computeCommandSha256(command: string): Promise<string> {
  const hash = createHash('sha256');
  try {
    const s = await stat(command);
    if (s.isFile()) {
      const buf = await readFile(command);
      hash.update(buf);
      return hash.digest('hex');
    }
  } catch {
    // fall through to literal-string mode
  }
  hash.update(command, 'utf8');
  return hash.digest('hex');
}

/** Per-server pinning input — the raw object from `.mcp.json`. */
export interface PinnableServerSpec {
  /** Resolved executable path or bare token. */
  command: string;
  /** Optional sha256 hex digest to verify against {@link computeCommandSha256}. */
  command_sha256?: string;
}

/**
 * Pure verification of a single server entry against pinning policy. Returns
 * `{ ok: true }` when the entry may be kept, or `{ ok: false, reason }`
 * carrying a human-readable explanation suitable for stderr.
 */
export async function verifyServer(
  spec: PinnableServerSpec,
  opts: LoadMcpServersOptions = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const pinned = opts.pinned === true;
  const declared = typeof spec.command_sha256 === 'string' ? spec.command_sha256 : undefined;

  if (declared === undefined) {
    if (pinned) {
      return { ok: false, reason: 'missing command_sha256 (pinned_mcp_servers=true)' };
    }
    return { ok: true };
  }

  if (!SHA256_HEX_RE.test(declared)) {
    return {
      ok: false,
      reason: `command_sha256 is not lowercase 64-hex (got "${declared}")`,
    };
  }

  const actual = await computeCommandSha256(spec.command);
  if (actual !== declared) {
    return { ok: false, reason: `expected ${declared}, got ${actual}` };
  }
  return { ok: true };
}

/**
 * Read `<workspaceRoot>/.mcp.json` and return its `mcpServers` map.
 *
 * When `opts.pinned` is true (mirroring `security.pinned_mcp_servers` in the
 * config), entries without `command_sha256` are dropped with a stderr warning;
 * entries with a mismatched checksum are always dropped.
 */
export async function loadMcpServers(
  workspaceRoot: string,
  opts: LoadMcpServersOptions = {},
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

    const declaredChecksum = readChecksum(value);
    const verify = await verifyServer(
      {
        command: coerced.command,
        ...(declaredChecksum !== undefined ? { command_sha256: declaredChecksum } : {}),
      },
      opts,
    );
    if (!verify.ok) {
      if (declaredChecksum === undefined) {
        process.stderr.write(
          `agent-os: .mcp.json server "${name}" has no command_sha256; skipping (security.pinned_mcp_servers=true)\n`,
        );
      } else {
        process.stderr.write(
          `agent-os: .mcp.json checksum mismatch for "${name}" (${verify.reason}); skipping\n`,
        );
      }
      continue;
    }

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

function readChecksum(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const cs = (value as Record<string, unknown>).command_sha256;
  return typeof cs === 'string' ? cs : undefined;
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
