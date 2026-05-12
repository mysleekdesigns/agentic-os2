import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Command } from 'commander';
import { loadConfig } from '../../config/index.js';

/**
 * Directories scaffolded by `agent-os init`. Order is meaningful only for
 * report output — creation itself is idempotent (mkdir recursive).
 */
const SCAFFOLD_DIRECTORIES: readonly string[] = [
  'agents',
  'agents/templates',
  'agents/examples',
  'workflows',
  'workflows/examples',
  'evals',
  'evals/fixtures',
  'evals/results',
  'memory',
  'logs',
  'blobs',
  '.agent-os',
];

/**
 * Directories that should carry a `.gitkeep` so they survive a `git add` even
 * when empty. Only the ones the PRD explicitly calls out.
 */
const GITKEEP_DIRECTORIES: readonly string[] = ['agents', 'workflows', 'evals/fixtures'];

const DEFAULT_CONFIG_FILENAME = 'agent-os.config.yaml';

/**
 * Embedded default config — must mirror PRD §2.5. Kept in TS so `init` does
 * not depend on the repo-root config file being present.
 */
const DEFAULT_CONFIG_YAML = `runtime:
  default_provider: claude_code_local
  storage: local_sqlite
  workspace_root: .
  require_approval_for_risky_tools: true

providers:
  claude_code_local:
    enabled: true
    requires_api_key: false
    sdk: "@anthropic-ai/claude-agent-sdk"
  anthropic_api:
    enabled: false
    api_key_env: ANTHROPIC_API_KEY
  openai_api:
    enabled: false
    api_key_env: OPENAI_API_KEY

security:
  default_tool_policy: deny
  risk_levels:
    read: allow
    write: approval_required
    network: approval_required
    shell: approval_required
    destructive: deny
  pinned_mcp_servers: true
  redact_secrets_in_logs: true

memory:
  enabled: true
  storage: local
  semantic_search: optional
  default_scopes: [project, user_preferences]

observability:
  local_logs: true
  traces: true
  otlp_exporter:
    enabled: false
    endpoint: ""

approvals:
  channels: [cli]
  default_ttl_minutes: 60
`;

export type DirectoryStatus = 'created' | 'exists';
export type ConfigStatus = 'created' | 'skipped' | 'overwrote';

export interface DirectoryResult {
  /** Absolute filesystem path. */
  readonly path: string;
  readonly status: DirectoryStatus;
}

export interface InitResult {
  /** Absolute path to the scaffolded workspace root. */
  readonly workspace: string;
  readonly directories: readonly DirectoryResult[];
  readonly config: ConfigStatus;
}

export interface RunInitOptions {
  /** Workspace root to scaffold. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  /** Overwrite an existing `agent-os.config.yaml` when true. */
  readonly force?: boolean;
}

/**
 * Pure, testable workhorse for the `init` command. Side effects are confined
 * to filesystem writes under the resolved workspace path. Returns a structured
 * summary so the Commander action (and tests) can format / assert without
 * re-running side effects.
 */
export function runInit(opts: RunInitOptions = {}): InitResult {
  const workspace = resolve(opts.cwd ?? process.cwd());
  const force = opts.force ?? false;

  // Ensure the workspace itself exists. `mkdir recursive` is a no-op when it
  // does, and creates any missing parents otherwise.
  mkdirSync(workspace, { recursive: true });

  const directories: DirectoryResult[] = SCAFFOLD_DIRECTORIES.map((relative) => {
    const absolute = join(workspace, relative);
    const status: DirectoryStatus = existsSync(absolute) ? 'exists' : 'created';
    if (status === 'created') {
      mkdirSync(absolute, { recursive: true });
    }
    return { path: absolute, status };
  });

  // Drop `.gitkeep` markers so empty scaffolded dirs survive `git add`.
  for (const relative of GITKEEP_DIRECTORIES) {
    const keepPath = join(workspace, relative, '.gitkeep');
    if (!existsSync(keepPath)) {
      writeFileSync(keepPath, '');
    }
  }

  const configPath = join(workspace, DEFAULT_CONFIG_FILENAME);
  let configStatus: ConfigStatus;
  if (existsSync(configPath)) {
    if (force) {
      writeFileSync(configPath, DEFAULT_CONFIG_YAML);
      configStatus = 'overwrote';
    } else {
      configStatus = 'skipped';
    }
  } else {
    writeFileSync(configPath, DEFAULT_CONFIG_YAML);
    configStatus = 'created';
  }

  // Round-trip validate the config we just wrote (or the one we left in
  // place) so `init` never reports success on a workspace whose config the
  // loader would later reject.
  loadConfig(configPath, { env: {} });

  return {
    workspace,
    directories,
    config: configStatus,
  };
}

/**
 * Render a TTY-friendly summary of an `InitResult`. Matches the format
 * specified in the Phase 1 bundle brief.
 */
function formatTextReport(result: InitResult): string {
  const createdCount = result.directories.filter((d) => d.status === 'created').length;

  const lines: string[] = [];
  lines.push(`agent-os: initialized workspace at ${result.workspace}`);
  lines.push(`  created: ${createdCount} directories`);
  for (const dir of result.directories) {
    lines.push(`  ${dir.path} (${dir.status})`);
  }
  lines.push(`  config: ${result.config}`);
  return lines.join('\n') + '\n';
}

interface InitCliOptions {
  cwd?: string;
  force?: boolean;
  json?: boolean;
}

export function buildInitCommand(): Command {
  const cmd = new Command('init');
  cmd
    .description('Scaffold a new Agent OS workspace in the target directory')
    .option('--cwd <path>', 'Workspace directory to scaffold', process.cwd())
    .option('--force', 'Overwrite an existing agent-os.config.yaml', false)
    .option('--json', 'Emit a machine-readable JSON summary', false)
    .action((options: InitCliOptions) => {
      try {
        const result = runInit({
          cwd: options.cwd,
          force: options.force,
        });

        if (options.json) {
          process.stdout.write(JSON.stringify(result) + '\n');
        } else {
          process.stdout.write(formatTextReport(result));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`agent-os init: ${message}\n`);
        process.exit(1);
      }
    });
  return cmd;
}
