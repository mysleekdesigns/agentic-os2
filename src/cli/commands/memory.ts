/**
 * `agent-os memory` command group: list / show / write / rm / search memory
 * entries from PRD §3 Phase 7.
 *
 * Reads-side commands open the same SQLite database the engine writes into
 * (`<workspace>/.agent-os/db.sqlite`, mirroring `workflow.ts`/`approvals.ts`),
 * run migrations idempotently, then call into `src/core/memory` for all logic.
 * This file only formats input/output, resolves the blob store, and (when an
 * `--agent-id` is provided) enforces the per-agent allow-list policy from
 * `src/core/memory/policy.ts` before delegating to the engine.
 *
 * Canonical reference: PRD §3 Phase 7.
 */

import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { Command } from 'commander';

import { loadConfig } from '../../config/index.js';
import { loadAgents, type AgentDefinition } from '../../core/agents/loader.js';
import {
  createMemory,
  enforceMemoryAccessOrThrow,
  getMemory,
  listMemory,
  MemoryPolicyDenied,
  readMemoryValue,
  removeMemory,
  searchMemory,
  updateMemory,
  writeMemoryIndex,
  type MemoryAction,
  type MemoryEntry,
  type MemorySearchResult,
} from '../../core/memory/index.js';
import { createBlobStore, type BlobStore } from '../../storage/blobs.js';
import { openDatabase, type AgentOsDb } from '../../storage/db.js';
import { runMigrations } from '../../storage/migrate.js';
import { events } from '../../storage/schema.js';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Workspace / DB / blob helpers (mirrors approvals.ts / workflow.ts)
// ---------------------------------------------------------------------------

function resolveWorkspaceRoot(cwd: string): string {
  const config = loadConfig(undefined, { env: process.env });
  const raw = config.runtime.workspace_root;
  return isAbsolute(raw) ? raw : resolve(cwd, raw);
}

function defaultDbPath(workspace: string): string {
  return process.env.AGENT_OS_DB ?? join(workspace, '.agent-os', 'db.sqlite');
}

async function openWorkspaceDb(workspace: string): Promise<AgentOsDb> {
  const dbPath = defaultDbPath(workspace);
  const db = openDatabase(dbPath);
  try {
    await runMigrations(db, { log: () => undefined });
  } catch (err) {
    db.$sqlite.close();
    throw err;
  }
  return db;
}

function openBlobStore(workspace: string): BlobStore {
  return createBlobStore({ root: join(workspace, '.agent-os', 'blobs') });
}

// ---------------------------------------------------------------------------
// Table formatter (matches agent.ts / workflow.ts look-and-feel)
// ---------------------------------------------------------------------------

function formatTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((h, col) => {
    let w = h.length;
    for (const row of rows) {
      const cell = row[col] ?? '';
      if (cell.length > w) w = cell.length;
    }
    return w;
  });
  const pad = (cells: readonly string[]) =>
    cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!))).join('  ');
  const lines: string[] = [];
  lines.push(pad(headers));
  for (const row of rows) lines.push(pad(row));
  return lines.join('\n') + '\n';
}

function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8);
}

function secondsToShort(seconds: number | null): string {
  if (seconds === null) return '—';
  return new Date(seconds * 1000)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, 'Z');
}

// ---------------------------------------------------------------------------
// Agent / policy helpers
// ---------------------------------------------------------------------------

async function loadAgentById(workspace: string, agentId: string): Promise<AgentDefinition> {
  const agentsDir = join(workspace, 'agents');
  const defs = await loadAgents(agentsDir);
  const def = defs.find((d) => d.frontmatter.id === agentId);
  if (!def) {
    throw new Error(`Agent not found: ${agentId}`);
  }
  return def;
}

/**
 * Build a memory event logger backed by the workspace `events` table. Used to
 * record `memory.denied` rows when the per-agent policy rejects a CLI call.
 */
function buildEventLogger(db: AgentOsDb): {
  emit: (args: { kind: string; payload: Record<string, unknown>; at: number }) => Promise<void>;
} {
  return {
    async emit({ kind, payload, at }) {
      await db.insert(events).values({
        id: randomUUID(),
        kind,
        payload: JSON.stringify(payload),
        createdAt: new Date(at * 1000),
      });
    },
  };
}

/**
 * Enforce `enforceMemoryAccessOrThrow` against an agent definition for a CLI
 * call. Returns gracefully on allow; on deny exits 1 with the policy message.
 * The engine has already logged `memory.denied` via the event logger.
 *
 * TODO(phase-12): without `--agent-id`, CLI calls are implicitly trusted as
 * the local user (no identity layer yet). Phase 12 will replace this with a
 * resolved identity that participates in policy.
 */
async function enforceCliPolicy(
  db: AgentOsDb,
  agentId: string | undefined,
  workspace: string,
  action: MemoryAction,
  scope: string,
): Promise<void> {
  if (!agentId) return;
  const def = await loadAgentById(workspace, agentId);
  const logger = buildEventLogger(db);
  try {
    enforceMemoryAccessOrThrow({
      agent: def.frontmatter,
      action,
      scope,
      eventLogger: logger,
    });
  } catch (err) {
    if (err instanceof MemoryPolicyDenied) {
      throw new Error(err.message);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// `memory list [<scope>]`
// ---------------------------------------------------------------------------

interface ListCliOptions {
  json?: boolean;
  all?: boolean;
  agentId?: string;
}

async function runList(
  cwd: string,
  scope: string | undefined,
  opts: ListCliOptions,
): Promise<void> {
  const workspace = resolveWorkspaceRoot(cwd);
  const db = await openWorkspaceDb(workspace);
  try {
    const rows = await listMemory({
      db,
      ...(scope !== undefined ? { scope } : {}),
      ...(opts.agentId !== undefined ? { agentId: opts.agentId } : {}),
      includeDeleted: opts.all === true,
    });

    if (opts.json) {
      process.stdout.write(JSON.stringify(rows) + '\n');
      return;
    }

    if (rows.length === 0) {
      process.stdout.write('No memory entries.\n');
      return;
    }

    const tableRows = rows.map((r) => [
      shortId(r.id),
      r.scope,
      r.key,
      r.agentId ?? '—',
      String(r.revision),
      secondsToShort(r.updatedAt),
      r.deletedAt !== null ? 'Y' : 'N',
    ]);
    process.stdout.write(
      formatTable(['ID', 'SCOPE', 'KEY', 'AGENT', 'REVISION', 'UPDATED_AT', 'DELETED'], tableRows),
    );
  } finally {
    db.$sqlite.close();
  }
}

// ---------------------------------------------------------------------------
// `memory show <id-or-scope:key>`
// ---------------------------------------------------------------------------

interface ShowCliOptions {
  json?: boolean;
}

/**
 * Resolve `<id-or-scope:key>` to a memory entry. The shorthand `scope:key`
 * is detected when the argument contains a colon; otherwise we treat it as a
 * memory id and scan the full list (cheap given Phase 7 sizes).
 */
async function resolveEntry(db: AgentOsDb, ref: string): Promise<MemoryEntry | null> {
  const colon = ref.indexOf(':');
  if (colon > 0 && colon < ref.length - 1) {
    const scope = ref.slice(0, colon);
    const key = ref.slice(colon + 1);
    return getMemory({ db, scope, key, includeDeleted: true });
  }
  const rows = await listMemory({ db, includeDeleted: true });
  return rows.find((r) => r.id === ref) ?? null;
}

function formatShowEntry(entry: MemoryEntry, value: string): string {
  const lines: string[] = [];
  lines.push(`id: ${entry.id}`);
  lines.push(`scope: ${entry.scope}`);
  lines.push(`key: ${entry.key}`);
  lines.push(`agent_id: ${entry.agentId ?? '—'}`);
  lines.push(`revision: ${entry.revision}`);
  lines.push(`value_ref: ${entry.valueRef}`);
  lines.push(`previous_value_ref: ${entry.previousValueRef ?? '—'}`);
  lines.push(`embedding_id: ${entry.embeddingId ?? '—'}`);
  lines.push(`created_at: ${secondsToShort(entry.createdAt)}`);
  lines.push(`updated_at: ${secondsToShort(entry.updatedAt)}`);
  lines.push(`deleted_at: ${secondsToShort(entry.deletedAt)}`);
  lines.push('');
  lines.push('value:');
  lines.push(value.endsWith('\n') ? value.slice(0, -1) : value);
  return lines.join('\n') + '\n';
}

async function runShow(cwd: string, ref: string, opts: ShowCliOptions): Promise<void> {
  const workspace = resolveWorkspaceRoot(cwd);
  const db = await openWorkspaceDb(workspace);
  try {
    const entry = await resolveEntry(db, ref);
    if (!entry) {
      process.stderr.write(`Memory not found: ${ref}\n`);
      process.exit(1);
    }
    const blobs = openBlobStore(workspace);
    let value = '';
    try {
      value = await readMemoryValue({ blobs, workspaceRoot: workspace, entry });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      value = `<unreadable: ${msg}>`;
    }

    if (opts.json) {
      process.stdout.write(JSON.stringify({ entry, value }) + '\n');
      return;
    }
    process.stdout.write(formatShowEntry(entry, value));
  } finally {
    db.$sqlite.close();
  }
}

// ---------------------------------------------------------------------------
// `memory write <scope> <key>`
// ---------------------------------------------------------------------------

interface WriteCliOptions {
  value?: string;
  file?: string;
  note?: string;
  agentId?: string;
  overwrite?: boolean;
  json?: boolean;
}

async function readStdinUtf8(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function resolveWriteValue(opts: WriteCliOptions): Promise<string> {
  if (opts.value !== undefined) return opts.value;
  if (opts.file !== undefined) {
    return (await readFile(opts.file, 'utf8')).toString();
  }
  const stdin = await readStdinUtf8();
  if (stdin.length === 0) {
    throw new Error(
      'memory write requires content via --value, --file, or stdin (e.g. `echo "..." | agent-os memory write ...`)',
    );
  }
  return stdin;
}

async function runWrite(
  cwd: string,
  scope: string,
  key: string,
  opts: WriteCliOptions,
): Promise<void> {
  const workspace = resolveWorkspaceRoot(cwd);
  const db = await openWorkspaceDb(workspace);
  try {
    // Per-agent policy is enforced before reading content so a denied write
    // surfaces fast and `memory.denied` lands in the audit log.
    await enforceCliPolicy(db, opts.agentId, workspace, 'write', scope);

    const value = await resolveWriteValue(opts);
    const blobs = openBlobStore(workspace);

    const existing = await getMemory({ db, scope, key, includeDeleted: true });

    let entry: MemoryEntry;
    if (!existing) {
      entry = await createMemory({
        db,
        blobs,
        workspaceRoot: workspace,
        scope,
        key,
        value,
        agentId: opts.agentId ?? null,
        revisionIntent: 'append',
      });
    } else {
      if (opts.overwrite) {
        process.stderr.write(
          `warning: --overwrite bypasses the diff-chain policy for ${scope}:${key}\n`,
        );
      } else if (!opts.note) {
        throw new Error(
          `memory write: --note <text> is required when updating an existing entry (${scope}:${key}). See PRD §3 Phase 7 diff-chain policy.`,
        );
      }
      entry = await updateMemory({
        db,
        blobs,
        workspaceRoot: workspace,
        scope,
        key,
        value,
        agentId: opts.agentId ?? null,
        revisionIntent: opts.overwrite ? 'overwrite' : 'update',
        ...(opts.note !== undefined ? { diffNote: opts.note } : {}),
      });
    }

    // The engine refreshes MEMORY.md on every successful write; we call
    // writeMemoryIndex explicitly here too so a partially-failed prior run
    // self-heals on the next write. Cheap and idempotent.
    const all = await listMemory({ db, includeDeleted: true });
    await writeMemoryIndex({
      workspaceRoot: workspace,
      entries: all.map((r) => ({
        scope: r.scope,
        key: r.key,
        hook: `rev ${r.revision} · agent ${r.agentId ?? 'system'}`,
        state: r.deletedAt !== null ? 'tombstoned' : 'live',
      })),
    });

    if (opts.json) {
      process.stdout.write(JSON.stringify(entry) + '\n');
      return;
    }
    const action = existing ? 'updated' : 'created';
    process.stdout.write(
      `${action}: ${entry.id} (${entry.scope}:${entry.key} rev ${entry.revision})\n`,
    );
  } finally {
    db.$sqlite.close();
  }
}

// ---------------------------------------------------------------------------
// `memory rm <id-or-scope:key>`
// ---------------------------------------------------------------------------

interface RmCliOptions {
  agentId?: string;
  note?: string;
  json?: boolean;
}

async function runRm(cwd: string, ref: string, opts: RmCliOptions): Promise<void> {
  const workspace = resolveWorkspaceRoot(cwd);
  const db = await openWorkspaceDb(workspace);
  try {
    const entry = await resolveEntry(db, ref);
    if (!entry) {
      process.stderr.write(`Memory not found: ${ref}\n`);
      process.exit(1);
    }

    await enforceCliPolicy(db, opts.agentId, workspace, 'rm', entry.scope);

    const blobs = openBlobStore(workspace);
    const removed = await removeMemory({
      db,
      blobs,
      workspaceRoot: workspace,
      scope: entry.scope,
      key: entry.key,
      ...(opts.agentId !== undefined ? { agentId: opts.agentId } : {}),
    });

    // Refresh the on-disk index (defensive — engine already did this).
    const all = await listMemory({ db, includeDeleted: true });
    await writeMemoryIndex({
      workspaceRoot: workspace,
      entries: all.map((r) => ({
        scope: r.scope,
        key: r.key,
        hook: `rev ${r.revision} · agent ${r.agentId ?? 'system'}`,
        state: r.deletedAt !== null ? 'tombstoned' : 'live',
      })),
    });

    if (opts.json) {
      process.stdout.write(JSON.stringify(removed) + '\n');
      return;
    }
    process.stdout.write(`removed: ${removed.id}\n`);
  } finally {
    db.$sqlite.close();
  }
}

// ---------------------------------------------------------------------------
// `memory search "<query>" [--scope ...]`
// ---------------------------------------------------------------------------

interface SearchCliOptions {
  scope: string[];
  topK?: string;
  agentId?: string;
  json?: boolean;
}

function collectScope(value: string, prev: string[]): string[] {
  prev.push(value);
  return prev;
}

async function runSearch(cwd: string, query: string, opts: SearchCliOptions): Promise<void> {
  const workspace = resolveWorkspaceRoot(cwd);
  const db = await openWorkspaceDb(workspace);
  try {
    const topK = opts.topK !== undefined ? Number.parseInt(opts.topK, 10) : 10;
    if (!Number.isFinite(topK) || topK <= 0) {
      throw new Error(`invalid --top-k: ${String(opts.topK)}`);
    }

    let scopes = opts.scope.length > 0 ? opts.scope.slice() : undefined;

    // When an agent is named, deny scopes it cannot read BEFORE the engine
    // runs. This also emits `memory.denied` rows for the audit log so the
    // exit-criterion test in `policy.ts`'s docstring works for `search` too.
    if (opts.agentId !== undefined) {
      const def = await loadAgentById(workspace, opts.agentId);
      const logger = buildEventLogger(db);
      const allowedScopes = scopes ?? def.frontmatter.memory.read ?? [];
      const filtered: string[] = [];
      for (const s of allowedScopes) {
        try {
          enforceMemoryAccessOrThrow({
            agent: def.frontmatter,
            action: 'search',
            scope: s,
            eventLogger: logger,
          });
          filtered.push(s);
        } catch (err) {
          if (err instanceof MemoryPolicyDenied) {
            // Already logged via eventLogger; just drop the scope.
            continue;
          }
          throw err;
        }
      }
      scopes = filtered;
      if (scopes.length === 0) {
        if (opts.json) {
          process.stdout.write('[]\n');
        } else {
          process.stdout.write('No accessible scopes for this agent.\n');
        }
        return;
      }
    }

    const blobs = openBlobStore(workspace);
    const results: MemorySearchResult[] = await searchMemory({
      db,
      blobs,
      query,
      ...(scopes !== undefined ? { scope: scopes } : {}),
      ...(opts.agentId !== undefined ? { agentId: opts.agentId } : {}),
      topK,
      // Phase 11 will wire in a provider-side embedder; until then we run the
      // engine's lexical fallback (PRD §3 Phase 7 / Phase 11).
      embedding: undefined,
    });

    if (opts.json) {
      process.stdout.write(JSON.stringify(results) + '\n');
      return;
    }
    if (results.length === 0) {
      process.stdout.write('No matches.\n');
      return;
    }
    const lines = results.map((r) => {
      const score = r.score.toFixed(2);
      const target = `${r.entry.scope}:${r.entry.key}`;
      const snippet = r.snippet.length > 0 ? ` — ${r.snippet}` : '';
      return `${score}  ${target}${snippet}`;
    });
    process.stdout.write(lines.join('\n') + '\n');
  } finally {
    db.$sqlite.close();
  }
}

// ---------------------------------------------------------------------------
// Command wiring
// ---------------------------------------------------------------------------

function withErrorReporting(fn: () => Promise<void>, label: string): () => Promise<void> {
  return async () => {
    try {
      await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`agent-os ${label}: ${message}\n`);
      process.exit(1);
    }
  };
}

export function buildMemoryCommand(): Command {
  const cmd = new Command('memory').description(
    'Inspect, write, search, and tombstone memory entries',
  );

  cmd
    .command('list [scope]')
    .description('List memory entries, optionally filtered by scope')
    .option('--all', 'Include tombstoned rows in the listing', false)
    .option('--agent-id <id>', 'Filter to entries written by this agent')
    .option('--json', 'Emit a machine-readable JSON array', false)
    .action((scope: string | undefined, options: ListCliOptions) =>
      withErrorReporting(() => runList(process.cwd(), scope, options), 'memory list')(),
    );

  cmd
    .command('show <id-or-scope:key>')
    .description('Show a single memory entry plus its current value')
    .option('--json', 'Emit a machine-readable JSON payload', false)
    .action((ref: string, options: ShowCliOptions) =>
      withErrorReporting(() => runShow(process.cwd(), ref, options), 'memory show')(),
    );

  cmd
    .command('write <scope> <key>')
    .description('Create or update a memory entry (value via --value, --file, or stdin)')
    .option('--value <text>', 'Inline value (small payloads)')
    .option('--file <path>', 'Read value from a file')
    .option('--note <text>', 'Diff note (required for updates without --overwrite)')
    .option('--agent-id <id>', 'Agent author; enforces per-agent memory.write policy')
    .option(
      '--overwrite',
      'Replace the value without the diff-chain check (admin/CLI bypass)',
      false,
    )
    .option('--json', 'Emit the updated row as JSON', false)
    .action((scope: string, key: string, options: WriteCliOptions) =>
      withErrorReporting(() => runWrite(process.cwd(), scope, key, options), 'memory write')(),
    );

  cmd
    .command('rm <id-or-scope:key>')
    .description('Tombstone a memory entry (row + blob retained for audit)')
    .option('--agent-id <id>', 'Agent author; enforces per-agent memory.write policy')
    .option('--note <text>', 'Reason recorded on the tombstone event')
    .option('--json', 'Emit the tombstoned row as JSON', false)
    .action((ref: string, options: RmCliOptions) =>
      withErrorReporting(() => runRm(process.cwd(), ref, options), 'memory rm')(),
    );

  cmd
    .command('search <query>')
    .description('Search live memories (lexical fallback; semantic in Phase 11)')
    .option('--scope <name>', 'Restrict to this scope (repeatable)', collectScope, [] as string[])
    .option('--top-k <n>', 'Maximum number of results', '10')
    .option('--agent-id <id>', 'Enforce per-agent memory.read policy before searching')
    .option('--json', 'Emit a machine-readable JSON array', false)
    .action((query: string, options: SearchCliOptions) =>
      withErrorReporting(() => runSearch(process.cwd(), query, options), 'memory search')(),
    );

  return cmd;
}
