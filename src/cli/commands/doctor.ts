/**
 * `agent-os doctor` — health check for the local workspace.
 *
 * Aggregates a `DoctorReport` covering:
 *  - workspace config presence + resolved root
 *  - high-level config slices (runtime, security, approvals)
 *  - provider registry + API-key env presence
 *  - `.mcp.json` parse status + command-on-PATH check (no servers started)
 *  - SQLite DB state (path, openable, migration count + last id)
 *  - tool versions (agent-os, node)
 *
 * PRD §3 Phase 10 exit: "A new user runs `agent-os doctor` and sees their
 * config, provider status, MCP server health, and DB version."
 */

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';

import { loadConfig } from '../../config/index.js';
import type { AgentOsConfig, ProvidersConfig } from '../../config/index.js';
import { openDatabase } from '../../storage/db.js';
import {
  defaultCapabilitiesFor,
  ensureBuiltinProvidersRegistered,
  hasProvider,
} from '../../core/providers/index.js';
import type { Capabilities, ProviderId } from '../../core/providers/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface PackageJson {
  version: string;
  name?: string;
}

/**
 * Resolve and read the repo `package.json`. Mirrors the helper in
 * `src/cli/index.ts` — duplicated rather than exported to keep the doctor
 * command self-contained.
 */
function loadPackageJson(): PackageJson {
  const pkgPath = resolve(__dirname, '..', '..', '..', 'package.json');
  const raw = readFileSync(pkgPath, 'utf8');
  return JSON.parse(raw) as PackageJson;
}

const DEFAULT_CONFIG_FILENAME = 'agent-os.config.yaml';

interface DoctorReportWorkspace {
  root: string;
  configPath: string;
  configFound: boolean;
}

interface DoctorReportConfig {
  runtime: {
    default_provider: string;
    storage: string;
    workspace_root: string;
  };
  security: { default_tool_policy: string };
  approvals: { channels: string[]; default_ttl_minutes: number };
}

interface DoctorReportProvider {
  id: ProviderId;
  enabled: boolean;
  requires_api_key: boolean;
  api_key_env: string | null;
  api_key_present: boolean;
  factory_registered: boolean;
  capabilities: Capabilities;
}

interface DoctorReportMcpServer {
  name: string;
  command: string;
  commandOnPath: boolean;
  ok: boolean;
  reason?: string;
}

interface DoctorReportMcp {
  file: string;
  found: boolean;
  servers: DoctorReportMcpServer[];
}

interface DoctorReportDb {
  path: string;
  open: boolean;
  migrationsApplied: number;
  lastMigration: string | null;
  schemaVersion: string | null;
  reason?: string;
}

interface DoctorReportVersions {
  agentOs: string;
  node: string;
}

export interface DoctorReport {
  ok: boolean;
  workspace: DoctorReportWorkspace;
  config: DoctorReportConfig | null;
  providers: DoctorReportProvider[];
  mcp: DoctorReportMcp;
  db: DoctorReportDb;
  versions: DoctorReportVersions;
  warnings: string[];
}

interface DoctorCliOptions {
  json?: boolean;
}

/**
 * Best-effort PATH lookup for an MCP server `command`. If the command is an
 * absolute path we just check `existsSync`; otherwise shell out to `which`.
 */
function commandOnPath(command: string): boolean {
  if (!command) return false;
  if (isAbsolute(command)) {
    return existsSync(command);
  }
  const result = spawnSync('which', [command], { encoding: 'utf8' });
  return (
    result.status === 0 && typeof result.stdout === 'string' && result.stdout.trim().length > 0
  );
}

interface RawMcpServerEntry {
  command?: unknown;
  args?: unknown;
  env?: unknown;
}

interface RawMcpFile {
  mcpServers?: Record<string, RawMcpServerEntry> | unknown;
}

/**
 * Parse `.mcp.json` and report each server's configuration status. We do NOT
 * start the servers — just confirm the file parses and the `command` binary
 * resolves on `$PATH`.
 */
function inspectMcpFile(workspaceRoot: string): DoctorReportMcp {
  const file = join(workspaceRoot, '.mcp.json');
  if (!existsSync(file)) {
    return { file, found: false, servers: [] };
  }

  let parsed: RawMcpFile;
  try {
    const raw = readFileSync(file, 'utf8');
    parsed = JSON.parse(raw) as RawMcpFile;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      file,
      found: true,
      servers: [
        {
          name: '(parse)',
          command: '',
          commandOnPath: false,
          ok: false,
          reason: `failed to parse .mcp.json: ${reason}`,
        },
      ],
    };
  }

  const mcpServers = parsed.mcpServers;
  if (mcpServers === null || typeof mcpServers !== 'object' || Array.isArray(mcpServers)) {
    return {
      file,
      found: true,
      servers: [
        {
          name: '(schema)',
          command: '',
          commandOnPath: false,
          ok: false,
          reason: '.mcp.json missing top-level "mcpServers" object',
        },
      ],
    };
  }

  const servers: DoctorReportMcpServer[] = [];
  for (const [name, entry] of Object.entries(mcpServers as Record<string, RawMcpServerEntry>)) {
    if (entry === null || typeof entry !== 'object') {
      servers.push({
        name,
        command: '',
        commandOnPath: false,
        ok: false,
        reason: 'server entry is not an object',
      });
      continue;
    }
    const command = typeof entry.command === 'string' ? entry.command : '';
    if (command.length === 0) {
      servers.push({
        name,
        command,
        commandOnPath: false,
        ok: false,
        reason: 'missing or non-string "command" field',
      });
      continue;
    }
    const onPath = commandOnPath(command);
    servers.push({
      name,
      command,
      commandOnPath: onPath,
      ok: true,
    });
  }

  return { file, found: true, servers };
}

/**
 * Open the workspace DB read-only-ish (we still open writable but never write)
 * and report migration bookkeeping. Returns `open: false` when the file
 * doesn't exist yet — doctor must not auto-create the database.
 */
function inspectDb(workspaceRoot: string): DoctorReportDb {
  const dbPath = process.env.AGENT_OS_DB ?? join(workspaceRoot, '.agent-os', 'agent-os.sqlite');
  if (!existsSync(dbPath)) {
    return {
      path: dbPath,
      open: false,
      migrationsApplied: 0,
      lastMigration: null,
      schemaVersion: null,
      reason: 'db file not found',
    };
  }

  try {
    const db = openDatabase(dbPath);
    try {
      // The migration runner creates `_agent_os_migrations(name, applied_at, status)`.
      // If it isn't there yet the DB was opened but never migrated — report 0.
      const tableRow = db.$sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='_agent_os_migrations'",
        )
        .get() as { name?: string } | undefined;

      if (!tableRow) {
        return {
          path: dbPath,
          open: true,
          migrationsApplied: 0,
          lastMigration: null,
          schemaVersion: null,
          reason: 'migrations table not present',
        };
      }

      const countRow = db.$sqlite
        .prepare("SELECT COUNT(*) AS n FROM _agent_os_migrations WHERE status = 'applied'")
        .get() as { n?: number } | undefined;
      const count = typeof countRow?.n === 'number' ? countRow.n : 0;

      const lastRow = db.$sqlite
        .prepare(
          "SELECT name FROM _agent_os_migrations WHERE status = 'applied' ORDER BY name DESC LIMIT 1",
        )
        .get() as { name?: string } | undefined;
      const last = typeof lastRow?.name === 'string' ? lastRow.name : null;

      return {
        path: dbPath,
        open: true,
        migrationsApplied: count,
        lastMigration: last,
        schemaVersion: last,
      };
    } finally {
      db.$sqlite.close();
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      path: dbPath,
      open: false,
      migrationsApplied: 0,
      lastMigration: null,
      schemaVersion: null,
      reason,
    };
  }
}

interface ProviderProbe {
  id: ProviderId;
  enabled: boolean;
  requiresApiKey: boolean;
  apiKeyEnv: string | null;
}

/**
 * Distil the relevant per-provider fields from the validated config into a
 * uniform probe shape. Centralises the `claude_code_local`-vs-API-key asymmetry
 * so the rest of the doctor logic stays branch-free.
 */
function providerProbes(providers: ProvidersConfig): ProviderProbe[] {
  return [
    {
      id: 'claude_code_local',
      enabled: providers.claude_code_local.enabled,
      requiresApiKey: providers.claude_code_local.requires_api_key,
      apiKeyEnv: null,
    },
    {
      id: 'anthropic_api',
      enabled: providers.anthropic_api.enabled,
      requiresApiKey: true,
      apiKeyEnv: providers.anthropic_api.api_key_env,
    },
    {
      id: 'openai_api',
      enabled: providers.openai_api.enabled,
      requiresApiKey: true,
      apiKeyEnv: providers.openai_api.api_key_env,
    },
  ];
}

/**
 * Resolve the workspace root that other commands use. Mirrors
 * `src/cli/commands/agent.ts` so doctor reports against the same root.
 */
function resolveWorkspaceRoot(cwd: string, config: AgentOsConfig | null): string {
  if (config === null) return resolve(cwd);
  const raw = config.runtime.workspace_root;
  return isAbsolute(raw) ? raw : resolve(cwd, raw);
}

async function buildReport(cwd: string, env: NodeJS.ProcessEnv): Promise<DoctorReport> {
  const configPath = resolve(cwd, DEFAULT_CONFIG_FILENAME);
  let config: AgentOsConfig | null = null;
  let configFound = false;
  const warnings: string[] = [];

  if (existsSync(configPath)) {
    configFound = true;
    try {
      config = loadConfig(configPath, { env });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      warnings.push(`config parse error: ${reason}`);
      config = null;
    }
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd, config);

  // Register the built-in provider factories so `hasProvider()` reflects
  // shipped adapters, not just whatever a test happened to register.
  await ensureBuiltinProvidersRegistered({});

  const probes = config
    ? providerProbes(config.providers)
    : providerProbes({
        // Synthesize defaults so doctor still reports something useful when
        // the config is missing.
        claude_code_local: { enabled: true, requires_api_key: false, sdk: '' },
        anthropic_api: { enabled: false, api_key_env: 'ANTHROPIC_API_KEY' },
        openai_api: { enabled: false, api_key_env: 'OPENAI_API_KEY' },
      });

  const providers: DoctorReportProvider[] = probes.map((p) => {
    const apiKeyPresent =
      p.apiKeyEnv !== null && typeof env[p.apiKeyEnv] === 'string' && env[p.apiKeyEnv]!.length > 0;
    return {
      id: p.id,
      enabled: p.enabled,
      requires_api_key: p.requiresApiKey,
      api_key_env: p.apiKeyEnv,
      api_key_present: apiKeyPresent,
      factory_registered: hasProvider(p.id),
      capabilities: defaultCapabilitiesFor(p.id),
    };
  });

  for (const prov of providers) {
    if (prov.enabled && prov.requires_api_key && prov.api_key_env && !prov.api_key_present) {
      warnings.push(`provider ${prov.id} is enabled but env var ${prov.api_key_env} is not set`);
    }
  }

  const mcp = inspectMcpFile(workspaceRoot);
  if (!mcp.found) {
    warnings.push(`.mcp.json not found at ${mcp.file}`);
  } else {
    for (const s of mcp.servers) {
      if (!s.ok) warnings.push(`mcp.${s.name}: ${s.reason ?? 'invalid entry'}`);
      else if (!s.commandOnPath) warnings.push(`mcp.${s.name}: command "${s.command}" not on PATH`);
    }
  }

  const db = inspectDb(workspaceRoot);
  if (!db.open) {
    warnings.push(`database not open: ${db.reason ?? 'unknown reason'}`);
  } else if (db.migrationsApplied === 0) {
    warnings.push('database has no applied migrations (run `npm run db:migrate`)');
  }

  const versions: DoctorReportVersions = {
    agentOs: loadPackageJson().version,
    node: process.versions.node,
  };

  const configSlice: DoctorReportConfig | null = config
    ? {
        runtime: {
          default_provider: config.runtime.default_provider,
          storage: config.runtime.storage,
          workspace_root: config.runtime.workspace_root,
        },
        security: { default_tool_policy: config.security.default_tool_policy },
        approvals: {
          channels: [...config.approvals.channels],
          default_ttl_minutes: config.approvals.default_ttl_minutes,
        },
      }
    : null;

  // ok rule: configFound && db.open. mcp.found contributes a warning only.
  const ok = configFound && db.open;

  return {
    ok,
    workspace: { root: workspaceRoot, configPath, configFound },
    config: configSlice,
    providers,
    mcp,
    db,
    versions,
    warnings,
  };
}

function formatCaps(caps: Capabilities): string {
  const flags: string[] = [];
  if (caps.streaming) flags.push('streaming');
  if (caps.tools) flags.push('tools');
  if (caps.mcp) flags.push('mcp');
  if (caps.vision) flags.push('vision');
  if (caps.costMetering) flags.push('cost-metering');
  if (caps.promptCaching) flags.push('prompt-caching');
  return flags.length === 0 ? '(none)' : flags.join(',');
}

function formatPretty(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push('agent-os doctor');
  lines.push('');

  lines.push('workspace');
  lines.push(`  root: ${report.workspace.root}`);
  lines.push(
    `  config: ${report.workspace.configPath} (${report.workspace.configFound ? 'ok' : 'missing'})`,
  );
  lines.push('');

  lines.push('config');
  if (report.config) {
    lines.push(`  default_provider: ${report.config.runtime.default_provider}`);
    lines.push(`  storage: ${report.config.runtime.storage}`);
    lines.push(`  security.default_tool_policy: ${report.config.security.default_tool_policy}`);
    lines.push(`  approvals.channels: [${report.config.approvals.channels.join(', ')}]`);
    lines.push(`  approvals.default_ttl_minutes: ${report.config.approvals.default_ttl_minutes}`);
  } else {
    lines.push('  (no config loaded)');
  }
  lines.push('');

  lines.push('providers');
  for (const p of report.providers) {
    const status = p.enabled ? 'enabled ' : 'disabled';
    const reg = p.factory_registered ? 'registered  ' : 'unregistered';
    let keyNote = '';
    if (p.requires_api_key && p.api_key_env) {
      keyNote = ` needs ${p.api_key_env} (${p.api_key_present ? 'set' : 'unset'})`;
    }
    lines.push(
      `  ${p.id.padEnd(20)} ${status}  ${reg}  caps: ${formatCaps(p.capabilities)}${keyNote}`,
    );
  }
  lines.push('');

  lines.push(`mcp servers (${report.mcp.file})`);
  if (!report.mcp.found) {
    lines.push('  (no .mcp.json found)');
  } else if (report.mcp.servers.length === 0) {
    lines.push('  (no servers configured)');
  } else {
    for (const s of report.mcp.servers) {
      if (!s.ok) {
        lines.push(`  ${s.name}  error: ${s.reason ?? 'invalid'}`);
      } else {
        const pathNote = s.commandOnPath ? 'command on PATH' : `command "${s.command}" NOT on PATH`;
        lines.push(`  ${s.name}  configured  ${pathNote}`);
      }
    }
  }
  lines.push('');

  lines.push('database');
  lines.push(`  path: ${report.db.path}`);
  if (!report.db.open) {
    lines.push(`  status: not open (${report.db.reason ?? 'unknown reason'})`);
  } else {
    lines.push(`  migrations applied: ${report.db.migrationsApplied}`);
    lines.push(`  last migration: ${report.db.lastMigration ?? '(none)'}`);
  }
  lines.push('');

  lines.push('versions');
  lines.push(`  agent-os: ${report.versions.agentOs}`);
  lines.push(`  node: ${report.versions.node}`);
  lines.push('');

  if (report.warnings.length > 0) {
    lines.push('warnings');
    for (const w of report.warnings) lines.push(`  - ${w}`);
    lines.push('');
  }

  lines.push(`status: ${report.ok ? 'OK' : 'FAIL'}`);
  return lines.join('\n') + '\n';
}

export function buildDoctorCommand(): Command {
  const cmd = new Command('doctor');
  cmd
    .description('Run a health check covering config, providers, MCP, and the local database')
    .option('--json', 'Emit a machine-readable JSON report', false)
    .action(async (options: DoctorCliOptions) => {
      try {
        const report = await buildReport(process.cwd(), process.env);
        if (options.json) {
          process.stdout.write(JSON.stringify(report) + '\n');
        } else {
          process.stdout.write(formatPretty(report));
        }
        if (!report.ok) {
          process.exit(1);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`agent-os doctor: ${message}\n`);
        process.exit(1);
      }
    });
  return cmd;
}
