/**
 * `agent-os provider` command group: lists configured providers (with their
 * capability matrix and api-key status) and toggles their `enabled` flag in
 * the workspace config.
 *
 * Read commands are pure; `enable` mutates the YAML config file on disk.
 *
 * Canonical reference: PRD §2.2 (provider seam), PRD Phase 3 (provider
 * factory + capabilities), PRD Phase 10 (CLI developer interface).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';
import yaml from 'js-yaml';

import { loadConfig } from '../../config/index.js';
import { defaultCapabilitiesFor } from '../../core/providers/capabilities.js';
import {
  ensureBuiltinProvidersRegistered,
  hasProvider,
  type Capabilities,
  type ProviderId,
} from '../../core/providers/index.js';

const DEFAULT_CONFIG_FILENAME = 'agent-os.config.yaml';
const KNOWN_PROVIDER_IDS: readonly ProviderId[] = [
  'claude_code_local',
  'anthropic_api',
  'openai_api',
];

// ---------------------------------------------------------------------------
// Helpers
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

function isProviderId(id: string): id is ProviderId {
  return (KNOWN_PROVIDER_IDS as readonly string[]).includes(id);
}

/** Default `api_key_env` for known providers when the config omits one. */
function defaultApiKeyEnvFor(id: string): string | null {
  switch (id) {
    case 'anthropic_api':
      return 'ANTHROPIC_API_KEY';
    case 'openai_api':
      return 'OPENAI_API_KEY';
    default:
      return null;
  }
}

/** Conservatively infer whether a provider needs an API key. */
function inferRequiresApiKey(id: string, fromConfig: boolean | undefined): boolean {
  if (typeof fromConfig === 'boolean') return fromConfig;
  return id === 'anthropic_api' || id === 'openai_api';
}

// ---------------------------------------------------------------------------
// `provider list`
// ---------------------------------------------------------------------------

interface ProviderListRow {
  id: string;
  enabled: boolean;
  requires_api_key: boolean;
  api_key_env: string | null;
  api_key_present: boolean;
  capabilities: Capabilities;
  factory_registered: boolean;
}

interface ListCliOptions {
  json?: boolean;
}

async function runProviderList(cwd: string, opts: ListCliOptions): Promise<void> {
  const config = loadConfig(undefined, { env: process.env });
  await ensureBuiltinProvidersRegistered(config as unknown as Record<string, unknown>);

  // Read the raw YAML so we can surface user-declared `requires_api_key` /
  // `api_key_env` even though the strict schema only models a subset.
  const configPath = resolve(cwd, DEFAULT_CONFIG_FILENAME);
  const raw = (() => {
    try {
      return yaml.load(readFileSync(configPath, 'utf8')) as Record<string, unknown> | null;
    } catch {
      return null;
    }
  })();
  const rawProviders =
    raw !== null && typeof raw === 'object' && raw.providers && typeof raw.providers === 'object'
      ? (raw.providers as Record<string, Record<string, unknown>>)
      : {};

  const ids = Object.keys(config.providers);

  const rows: ProviderListRow[] = ids.map((id) => {
    const cfg = (config.providers as Record<string, { enabled: boolean }>)[id];
    const rawEntry = rawProviders[id] ?? {};
    const rawRequires =
      typeof rawEntry.requires_api_key === 'boolean' ? rawEntry.requires_api_key : undefined;
    const requiresApiKey = inferRequiresApiKey(id, rawRequires);
    const apiKeyEnv =
      typeof rawEntry.api_key_env === 'string' && rawEntry.api_key_env.length > 0
        ? rawEntry.api_key_env
        : defaultApiKeyEnvFor(id);
    const apiKeyPresent =
      apiKeyEnv !== null && typeof process.env[apiKeyEnv] === 'string'
        ? process.env[apiKeyEnv]!.length > 0
        : false;
    const capabilities = isProviderId(id)
      ? defaultCapabilitiesFor(id)
      : ({
          streaming: false,
          tools: false,
          mcp: false,
          vision: false,
          costMetering: false,
          promptCaching: false,
        } satisfies Capabilities);
    const factoryRegistered = isProviderId(id) ? hasProvider(id) : false;

    return {
      id,
      enabled: Boolean(cfg?.enabled),
      requires_api_key: requiresApiKey,
      api_key_env: apiKeyEnv,
      api_key_present: apiKeyPresent,
      capabilities,
      factory_registered: factoryRegistered,
    };
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify(rows) + '\n');
    return;
  }

  // Pretty: one block per provider, padded id, status, key hint, capability summary.
  const idWidth = Math.max(...rows.map((r) => r.id.length), 1);
  const lines: string[] = [];
  for (const row of rows) {
    const status = row.enabled ? 'enabled ' : 'disabled';
    let keyHint: string;
    if (!row.requires_api_key) {
      keyHint = 'no-key      ';
    } else if (row.api_key_env === null) {
      keyHint = 'needs api key (env not configured)';
    } else if (row.api_key_present) {
      keyHint = `needs ${row.api_key_env} (set)`;
    } else {
      keyHint = `needs ${row.api_key_env} (unset)`;
    }
    const caps = `streaming=${row.capabilities.streaming} tools=${row.capabilities.tools} mcp=${row.capabilities.mcp}`;
    lines.push(`${row.id.padEnd(idWidth)}  ${status}  ${keyHint}  ${caps}`);
  }
  process.stdout.write(lines.join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// `provider enable <id>`
// ---------------------------------------------------------------------------

interface EnableCliOptions {
  json?: boolean;
  config?: string;
  disable?: boolean;
}

async function runProviderEnable(cwd: string, id: string, opts: EnableCliOptions): Promise<void> {
  const configPath = resolve(opts.config ?? resolve(cwd, DEFAULT_CONFIG_FILENAME));

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to read config at "${configPath}": ${reason}`);
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to parse YAML at "${configPath}": ${reason}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`config at "${configPath}" is not a YAML mapping`);
  }

  const root = parsed as Record<string, unknown>;
  const providers =
    root.providers && typeof root.providers === 'object' && !Array.isArray(root.providers)
      ? (root.providers as Record<string, unknown>)
      : null;

  if (!providers || !(id in providers)) {
    throw new Error(`unknown provider "${id}" — not present in providers block of ${configPath}`);
  }

  const entry =
    providers[id] && typeof providers[id] === 'object' && !Array.isArray(providers[id])
      ? (providers[id] as Record<string, unknown>)
      : null;
  if (!entry) {
    throw new Error(`provider entry "${id}" is not a mapping in ${configPath}`);
  }

  const nextEnabled = !opts.disable;
  entry.enabled = nextEnabled;

  // Preserve top-level key order by re-dumping the same object (js-yaml keeps
  // insertion order). Comments are NOT preserved — total fidelity isn't
  // required, but we keep the round-trip tight.
  const output = yaml.dump(root, {
    indent: 2,
    lineWidth: 100,
    noRefs: true,
    quotingType: '"',
  });
  writeFileSync(configPath, output);

  // Pre-flight: warn (on stderr) if enabling an API provider without its key.
  const apiKeyEnv =
    typeof entry.api_key_env === 'string' && entry.api_key_env.length > 0
      ? (entry.api_key_env as string)
      : defaultApiKeyEnvFor(id);
  const apiKeyPresent =
    apiKeyEnv !== null && typeof process.env[apiKeyEnv] === 'string'
      ? process.env[apiKeyEnv]!.length > 0
      : false;

  let warning: string | null = null;
  if (nextEnabled && (id === 'anthropic_api' || id === 'openai_api') && !apiKeyPresent) {
    warning = `warning: enabling ${id} but ${apiKeyEnv ?? '(unknown env)'} is not set in the current environment`;
    process.stderr.write(`agent-os provider enable: ${warning}\n`);
  }

  if (opts.json) {
    const payload = {
      id,
      enabled: nextEnabled,
      api_key_env: apiKeyEnv,
      api_key_present: apiKeyPresent,
    };
    process.stdout.write(JSON.stringify(payload) + '\n');
    return;
  }

  process.stdout.write(`provider ${id} ${nextEnabled ? 'enabled' : 'disabled'}\n`);
}

// ---------------------------------------------------------------------------
// Command wiring
// ---------------------------------------------------------------------------

export function buildProviderCommand(): Command {
  const cmd = new Command('provider').description('Inspect and toggle provider adapters');

  cmd
    .command('list')
    .description('List configured providers with capability + api-key status')
    .option('--json', 'Emit a machine-readable JSON array', false)
    .action((options: ListCliOptions) =>
      withErrorReporting(() => runProviderList(process.cwd(), options), 'provider list')(),
    );

  cmd
    .command('enable <id>')
    .description('Toggle a provider on (default) or off (--disable) in agent-os.config.yaml')
    .option('--json', 'Emit a machine-readable JSON summary', false)
    .option('--config <path>', 'Path to the agent-os.config.yaml file to mutate')
    .option('--disable', 'Set enabled=false instead of true', false)
    .action((id: string, options: EnableCliOptions) =>
      withErrorReporting(() => runProviderEnable(process.cwd(), id, options), 'provider enable')(),
    );

  return cmd;
}
