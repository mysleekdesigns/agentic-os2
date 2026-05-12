/**
 * `agent-os agent` command group: lists / inspects / syncs agent definitions
 * loaded from `<workspace_root>/agents/`.
 *
 * Reads-side commands (`list`, `show`) touch only the filesystem. `sync` also
 * upserts the registry table and mirrors files into `<workspace>/.claude/agents/`
 * via Bundle A's helpers (loader / registry / mirror).
 *
 * Canonical reference: PRD §2.6 (agent definitions) and PRD Phase 2.
 */

import { resolve, relative, isAbsolute, join } from 'node:path';
import { Command } from 'commander';

import { loadConfig } from '../../config/index.js';
import { loadAgents, type AgentDefinition } from '../../core/agents/loader.js';
import { syncRegistry, type RegistryUpsertResult } from '../../core/agents/registry.js';
import { mirrorToClaudeAgents, type MirrorResult } from '../../core/agents/mirror.js';
import { openDatabase } from '../../storage/db.js';
import { runMigrations } from '../../storage/migrate.js';

/**
 * Resolve `<workspace_root>` from the loaded config, honouring the convention
 * that `runtime.workspace_root` may be relative to the config file's directory
 * (or, in practice, `process.cwd()` since the config is read from cwd here).
 */
function resolveWorkspaceRoot(cwd: string): string {
  // `loadConfig` defaults to `agent-os.config.yaml` in cwd; honour the same.
  const config = loadConfig(undefined, { env: process.env });
  const raw = config.runtime.workspace_root;
  return isAbsolute(raw) ? raw : resolve(cwd, raw);
}

/** Path of the SQLite database used by `agent sync` for the registry table. */
function defaultDbPath(workspace: string): string {
  return process.env.AGENT_OS_DB ?? join(workspace, '.agent-os', 'agent-os.sqlite');
}

// ---------------------------------------------------------------------------
// `agent list`
// ---------------------------------------------------------------------------

interface ListJsonRow {
  id: string;
  name: string;
  version: number;
  provider: string;
  model: string | null;
  path: string;
  hash: string;
}

function toListRow(def: AgentDefinition): ListJsonRow {
  return {
    id: def.frontmatter.id,
    name: def.frontmatter.name,
    version: def.frontmatter.version,
    provider: def.frontmatter.provider,
    model: def.frontmatter.model ?? null,
    path: def.path,
    hash: def.hash,
  };
}

/**
 * Render a simple left-aligned column report. Width per column is the max of
 * the header and the longest cell. Single-space gutter; no decorative borders.
 */
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

interface ListCliOptions {
  json?: boolean;
}

async function runList(cwd: string, opts: ListCliOptions): Promise<void> {
  const workspace = resolveWorkspaceRoot(cwd);
  const agentsDir = join(workspace, 'agents');
  const defs = await loadAgents(agentsDir);

  if (opts.json) {
    process.stdout.write(JSON.stringify(defs.map(toListRow)) + '\n');
    return;
  }

  if (defs.length === 0) {
    process.stdout.write(`No agents found in ${agentsDir}\n`);
    return;
  }

  const rows = defs.map((d) => [
    d.frontmatter.id,
    d.frontmatter.name,
    String(d.frontmatter.version),
    d.frontmatter.provider,
    relative(cwd, d.path) || d.path,
  ]);
  process.stdout.write(formatTable(['ID', 'NAME', 'VERSION', 'PROVIDER', 'PATH'], rows));
}

// ---------------------------------------------------------------------------
// `agent show <id>`
// ---------------------------------------------------------------------------

interface ShowCliOptions {
  json?: boolean;
}

function formatList(values: readonly string[]): string {
  return values.length === 0 ? '(none)' : values.join(', ');
}

function formatShow(def: AgentDefinition): string {
  const fm = def.frontmatter;
  const lines: string[] = [];
  lines.push(`id: ${fm.id}`);
  lines.push(`name: ${fm.name}`);
  lines.push(`version: ${fm.version}`);
  lines.push(`role: ${fm.role}`);
  lines.push(`provider: ${fm.provider}`);
  if (fm.model) lines.push(`model: ${fm.model}`);
  lines.push('tools:');
  lines.push(`  allowed: ${formatList(fm.tools.allowed)}`);
  lines.push(`  approval_required: ${formatList(fm.tools.approval_required)}`);
  lines.push('permissions:');
  lines.push(`  network: ${fm.permissions.network}`);
  lines.push(`  file_read: ${fm.permissions.file_read}`);
  lines.push(`  file_write: ${fm.permissions.file_write}`);
  lines.push(`  shell: ${fm.permissions.shell}`);
  lines.push('memory:');
  lines.push(`  read: ${formatList(fm.memory.read)}`);
  lines.push(`  write: ${formatList(fm.memory.write)}`);
  if (fm.eval) {
    lines.push('eval:');
    if (fm.eval.fixtures !== undefined) {
      const fixtures = Array.isArray(fm.eval.fixtures)
        ? fm.eval.fixtures.join(', ')
        : fm.eval.fixtures;
      lines.push(`  fixtures: ${fixtures}`);
    }
    lines.push(`  success_criteria: ${formatList(fm.eval.success_criteria)}`);
  }
  lines.push('---');
  lines.push(def.body.endsWith('\n') ? def.body.slice(0, -1) : def.body);
  return lines.join('\n') + '\n';
}

async function runShow(cwd: string, id: string, opts: ShowCliOptions): Promise<void> {
  const workspace = resolveWorkspaceRoot(cwd);
  const agentsDir = join(workspace, 'agents');
  const defs = await loadAgents(agentsDir);

  const def = defs.find((d) => d.frontmatter.id === id);
  if (!def) {
    process.stderr.write(`Agent not found: ${id}\n`);
    process.exit(1);
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(def) + '\n');
    return;
  }

  process.stdout.write(formatShow(def));
}

// ---------------------------------------------------------------------------
// `agent sync`
// ---------------------------------------------------------------------------

interface SyncCliOptions {
  json?: boolean;
}

interface SyncReport {
  registry: RegistryUpsertResult;
  mirror: MirrorResult;
}

async function runSync(cwd: string, opts: SyncCliOptions): Promise<void> {
  const workspace = resolveWorkspaceRoot(cwd);
  const agentsDir = join(workspace, 'agents');
  const claudeAgentsDir = join(workspace, '.claude', 'agents');
  const defs = await loadAgents(agentsDir);

  const dbPath = defaultDbPath(workspace);
  const db = openDatabase(dbPath);
  let report: SyncReport;
  try {
    // Ensure the `agents` table exists before we try to upsert into it. The
    // migrate runner is idempotent so this is safe to invoke on every sync.
    await runMigrations(db, { log: () => undefined });
    const registry = await syncRegistry(db, defs);
    const mirror = await mirrorToClaudeAgents(defs, claudeAgentsDir);
    report = { registry, mirror };
  } finally {
    db.$sqlite.close();
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(report) + '\n');
    return;
  }

  const r = report.registry;
  const m = report.mirror;
  process.stdout.write(
    `Registry: ${r.inserted} inserted, ${r.updated} updated, ${r.unchanged} unchanged\n` +
      `Mirror:   ${m.written.length} written, ${m.removed.length} removed\n`,
  );
}

// ---------------------------------------------------------------------------
// Command wiring
// ---------------------------------------------------------------------------

/**
 * Wrap an async Commander action so failures print a tidy message to stderr
 * and exit non-zero rather than producing an unhandled rejection.
 */
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

export function buildAgentCommand(): Command {
  const cmd = new Command('agent').description('Inspect and manage agent definitions');

  cmd
    .command('list')
    .description('List all agents in the workspace')
    .option('--json', 'Emit a machine-readable JSON array', false)
    .action((options: ListCliOptions) =>
      withErrorReporting(() => runList(process.cwd(), options), 'agent list')(),
    );

  cmd
    .command('show <id>')
    .description('Show full details for an agent by id')
    .option('--json', 'Emit the full AgentDefinition as JSON', false)
    .action((id: string, options: ShowCliOptions) =>
      withErrorReporting(() => runShow(process.cwd(), id, options), 'agent show')(),
    );

  cmd
    .command('sync')
    .description('Sync agents into the registry table and mirror to .claude/agents/')
    .option('--json', 'Emit a machine-readable JSON summary', false)
    .action((options: SyncCliOptions) =>
      withErrorReporting(() => runSync(process.cwd(), options), 'agent sync')(),
    );

  return cmd;
}
