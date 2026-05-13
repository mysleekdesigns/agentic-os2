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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { Command } from 'commander';
import yaml from 'js-yaml';

import { loadConfig } from '../../config/index.js';
import { loadAgents, type AgentDefinition } from '../../core/agents/loader.js';
import { syncRegistry, type RegistryUpsertResult } from '../../core/agents/registry.js';
import { mirrorToClaudeAgents, type MirrorResult } from '../../core/agents/mirror.js';
import { AgentFrontmatterSchema } from '../../core/agents/schema.js';
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
// `agent new <id>`
// ---------------------------------------------------------------------------

/** Slug constraint enforced for newly-scaffolded agents (CLI-side check). */
const NEW_ID_REGEX = /^[a-z][a-z0-9_]*$/;

interface NewCliOptions {
  name?: string;
  role?: string;
  from?: string;
  provider?: string;
  model?: string;
  force?: boolean;
  json?: boolean;
}

interface NewResult {
  id: string;
  path: string;
  mirrorPath: string;
  fixturePath: string;
}

/** Humanise an id like `my_bot` → `My Bot` for the default display name. */
function humaniseId(id: string): string {
  return id
    .split('_')
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * Split a markdown file into [frontmatter YAML text, body text]. Mirrors the
 * loader's delimiter logic but works synchronously on already-read text.
 */
function splitFrontmatter(text: string): { yamlText: string; body: string } {
  const openMatch = /^---\s*\r?\n/.exec(text);
  if (!openMatch) {
    throw new Error('template is missing leading `---` frontmatter delimiter');
  }
  const afterOpen = text.slice(openMatch[0].length);
  const closeMatch = /\n---\s*(\r?\n|$)/.exec(afterOpen);
  if (!closeMatch) {
    throw new Error('template is missing closing `---` frontmatter delimiter');
  }
  return {
    yamlText: afterOpen.slice(0, closeMatch.index),
    body: afterOpen.slice(closeMatch.index + closeMatch[0].length),
  };
}

/**
 * Produce the minimal agent frontmatter+body when `--from` is not supplied.
 * The shape must validate against AgentFrontmatterSchema; we serialise via
 * js-yaml so structure stays consistent with mirror output.
 */
function buildMinimalAgent(
  id: string,
  name: string,
  role: string,
  provider: string,
  model: string | undefined,
): { text: string } {
  const frontmatter: Record<string, unknown> = {
    id,
    name,
    version: 1,
    role,
    provider,
  };
  if (model !== undefined && model.length > 0) {
    frontmatter.model = model;
  }
  frontmatter.tools = {
    allowed: ['fs.read'],
    approval_required: ['fs.write'],
  };
  frontmatter.permissions = {
    network: 'deny',
    file_read: 'allow',
    file_write: 'approval_required',
    shell: 'deny',
  };
  frontmatter.memory = {
    read: ['project'],
    write: [],
  };
  frontmatter.eval = {
    fixtures: `evals/fixtures/${id}/*.yaml`,
    success_criteria: ["completes the user's goal without writing files unprompted"],
  };

  const yamlText = yaml.dump(frontmatter, {
    lineWidth: 100,
    noRefs: true,
    sortKeys: false,
  });

  const body = `# ${name}\n\nYou are ${name}. ${role}.\n\n## Inputs\n- The user's goal as a single prompt.\n\n## Output format\n- A short markdown response.\n`;

  return { text: `---\n${yamlText}---\n\n${body}` };
}

/**
 * Build the new agent file by cloning a starter template's frontmatter, only
 * rewriting `id`, `name`, and `eval.fixtures`. The body is preserved verbatim.
 */
function buildFromTemplate(
  templatePath: string,
  id: string,
  name: string,
  provider: string | undefined,
  model: string | undefined,
): { text: string } {
  const raw = readFileSync(templatePath, 'utf8');
  const { yamlText, body } = splitFrontmatter(raw);
  const parsed = yaml.load(yamlText);
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`template ${templatePath} has invalid frontmatter`);
  }
  const fm = parsed as Record<string, unknown>;
  fm.id = id;
  fm.name = name;
  if (provider !== undefined) fm.provider = provider;
  if (model !== undefined && model.length > 0) fm.model = model;
  // Rewrite eval.fixtures to point at the new id's fixture dir.
  const evalBlock = fm.eval;
  if (evalBlock !== null && typeof evalBlock === 'object') {
    (evalBlock as Record<string, unknown>).fixtures = `evals/fixtures/${id}/*.yaml`;
  } else {
    fm.eval = {
      fixtures: `evals/fixtures/${id}/*.yaml`,
      success_criteria: ["completes the user's goal"],
    };
  }

  const yamlOut = yaml.dump(fm, { lineWidth: 100, noRefs: true, sortKeys: false });
  return { text: `---\n${yamlOut}---\n${body}` };
}

/** Render the starter smoke eval fixture YAML for a freshly-scaffolded agent. */
function renderSmokeFixture(id: string, name: string): string {
  return (
    `description: 'Smoke test for ${id}: completes a simple goal without errors.'\n\n` +
    `prompts:\n` +
    `  - 'Say hello and confirm you are ${name}.'\n\n` +
    `providers:\n` +
    `  - id: agent-os:${id}\n\n` +
    `tests:\n` +
    `  - description: 'Happy path — agent responds.'\n` +
    `    assert:\n` +
    `      - type: icontains\n` +
    `        value: 'hello'\n`
  );
}

async function runNew(cwd: string, id: string, opts: NewCliOptions): Promise<void> {
  if (!NEW_ID_REGEX.test(id)) {
    process.stderr.write(
      `agent-os agent new: invalid id "${id}" — must match /^[a-z][a-z0-9_]*$/\n`,
    );
    process.exit(1);
    return;
  }

  const workspace = resolveWorkspaceRoot(cwd);
  const agentsDir = join(workspace, 'agents');
  const claudeAgentsDir = join(workspace, '.claude', 'agents');
  const fixturesDir = join(workspace, 'evals', 'fixtures', id);

  const targetPath = join(agentsDir, `${id}.md`);
  const mirrorPath = join(claudeAgentsDir, `${id}.md`);
  const fixturePath = join(fixturesDir, 'smoke.yaml');

  const force = opts.force ?? false;
  if (existsSync(targetPath) && !force) {
    process.stderr.write(
      `agent-os agent new: ${relative(cwd, targetPath) || targetPath} already exists (use --force to overwrite)\n`,
    );
    process.exit(1);
    return;
  }

  const name = opts.name && opts.name.length > 0 ? opts.name : humaniseId(id);
  const role = opts.role && opts.role.length > 0 ? opts.role : 'Custom agent';
  const provider = opts.provider && opts.provider.length > 0 ? opts.provider : 'claude_code_local';

  let text: string;
  if (opts.from !== undefined && opts.from.length > 0) {
    const templatePath = join(agentsDir, 'templates', `${opts.from}.md`);
    if (!existsSync(templatePath)) {
      process.stderr.write(
        `agent-os agent new: template not found at ${relative(cwd, templatePath) || templatePath}\n`,
      );
      process.exit(1);
      return;
    }
    // When `--from` is given, copy the template verbatim except id/name/eval —
    // only override provider/model if the caller explicitly supplied them.
    text = buildFromTemplate(
      templatePath,
      id,
      name,
      opts.provider !== undefined && opts.provider.length > 0 ? opts.provider : undefined,
      opts.model,
    ).text;
  } else {
    text = buildMinimalAgent(id, name, role, provider, opts.model).text;
  }

  // Validate the generated frontmatter against the schema before any writes.
  const { yamlText } = splitFrontmatter(text);
  const parsedFm = yaml.load(yamlText);
  AgentFrontmatterSchema.parse(parsedFm);

  // Ensure directories exist (workspace `init` creates `agents/` and
  // `evals/fixtures/` already, but `.claude/agents/` and the per-id fixture
  // dir might not).
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(claudeAgentsDir, { recursive: true });
  mkdirSync(fixturesDir, { recursive: true });

  // Write the canonical file, the mirror (identical contents — Claude Code's
  // loader ignores unknown frontmatter keys), and the starter eval fixture.
  writeFileSync(targetPath, text, 'utf8');
  writeFileSync(mirrorPath, text, 'utf8');
  writeFileSync(fixturePath, renderSmokeFixture(id, name), 'utf8');

  const result: NewResult = {
    id,
    path: targetPath,
    mirrorPath,
    fixturePath,
  };

  if (opts.json) {
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }

  const rel = (p: string) => relative(cwd, p) || p;
  process.stdout.write(
    `Created agent ${id}:\n` +
      `  ${rel(targetPath)}\n` +
      `  ${rel(mirrorPath)}\n` +
      `  ${rel(fixturePath)}\n` +
      `Tip: run \`agent-os agent sync\` to register.\n`,
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

  cmd
    .command('new <id>')
    .description('Scaffold a new agent definition, mirror, and starter eval fixture')
    .option('--name <name>', 'Display name (default: humanised id)')
    .option('--role <role>', 'Short role description', 'Custom agent')
    .option('--from <template-id>', 'Base on agents/templates/<template-id>.md')
    .option(
      '--provider <id>',
      'Provider id (claude_code_local | anthropic_api | openai_api)',
      'claude_code_local',
    )
    .option('--model <name>', 'Optional model name')
    .option('--force', 'Overwrite if agents/<id>.md already exists', false)
    .option('--json', 'Emit { id, path, mirrorPath, fixturePath } on success', false)
    .action((id: string, options: NewCliOptions) =>
      withErrorReporting(() => runNew(process.cwd(), id, options), 'agent new')(),
    );

  return cmd;
}
