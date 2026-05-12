import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { ZodError } from 'zod';
import { AgentOsConfigSchema, type AgentOsConfig } from './schema.js';

export { AgentOsConfigSchema } from './schema.js';
export type {
  AgentOsConfig,
  RuntimeConfig,
  ProvidersConfig,
  ClaudeCodeLocalProviderConfig,
  AnthropicApiProviderConfig,
  OpenAiApiProviderConfig,
  SecurityConfig,
  RiskLevels,
  RiskAction,
  MemoryConfig,
  ObservabilityConfig,
  OtlpExporterConfig,
  ApprovalsConfig,
} from './schema.js';

const DEFAULT_CONFIG_FILENAME = 'agent-os.config.yaml';

/**
 * Format a Zod validation error into a single human-readable string suitable
 * for inclusion in a thrown Error.
 */
function summarizeZodIssues(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `  - ${path}: ${issue.message}`;
    })
    .join('\n');
}

const TRUTHY_BOOL_STRINGS = new Set(['1', 'true', 'yes', 'on']);
const FALSY_BOOL_STRINGS = new Set(['0', 'false', 'no', 'off']);

/**
 * Parse an env-var string into a strict boolean. Accepts a small, explicit
 * vocabulary so misconfiguration fails loudly instead of silently coercing.
 */
function parseBooleanEnv(name: string, value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (TRUTHY_BOOL_STRINGS.has(normalized)) return true;
  if (FALSY_BOOL_STRINGS.has(normalized)) return false;
  throw new Error(
    `Invalid boolean value for env var ${name}: "${value}". ` +
      `Expected one of: 1, true, yes, on, 0, false, no, off.`,
  );
}

/**
 * Assign `value` at the given dotted `path` inside `target`, creating any
 * missing intermediate plain-object containers along the way. Existing
 * non-object values along the path are overwritten with a new object so the
 * assignment can proceed — this mirrors the "env wins" precedence rule.
 */
function setAtPath(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i]!;
    const existing = cursor[key];
    if (existing === null || typeof existing !== 'object' || Array.isArray(existing)) {
      const next: Record<string, unknown> = {};
      cursor[key] = next;
      cursor = next;
    } else {
      cursor = existing as Record<string, unknown>;
    }
  }
  cursor[path[path.length - 1]!] = value;
}

type EnvOverlayKind = 'string' | 'boolean';

interface EnvOverlayRule {
  readonly env: string;
  readonly path: readonly string[];
  readonly kind: EnvOverlayKind;
}

/**
 * Declarative map of env-var → config-path overlays. Adding a new override is
 * a one-line change here. Only routing / enable-flag style settings live in
 * this table — provider API keys are intentionally NOT read here (they are
 * surfaced by the provider layer in later phases so the storage/config layer
 * works with no API key set, per PRD §4).
 */
const ENV_OVERLAY_RULES: readonly EnvOverlayRule[] = [
  {
    env: 'AGENT_OS_DEFAULT_PROVIDER',
    path: ['runtime', 'default_provider'],
    kind: 'string',
  },
  {
    env: 'AGENT_OS_WORKSPACE_ROOT',
    path: ['runtime', 'workspace_root'],
    kind: 'string',
  },
  {
    env: 'AGENT_OS_REQUIRE_APPROVAL_FOR_RISKY_TOOLS',
    path: ['runtime', 'require_approval_for_risky_tools'],
    kind: 'boolean',
  },
  {
    env: 'AGENT_OS_ANTHROPIC_API_ENABLED',
    path: ['providers', 'anthropic_api', 'enabled'],
    kind: 'boolean',
  },
  {
    env: 'AGENT_OS_OPENAI_API_ENABLED',
    path: ['providers', 'openai_api', 'enabled'],
    kind: 'boolean',
  },
  {
    env: 'AGENT_OS_REDACT_SECRETS_IN_LOGS',
    path: ['security', 'redact_secrets_in_logs'],
    kind: 'boolean',
  },
  {
    env: 'AGENT_OS_OTLP_ENABLED',
    path: ['observability', 'otlp_exporter', 'enabled'],
    kind: 'boolean',
  },
  {
    env: 'AGENT_OS_OTLP_ENDPOINT',
    path: ['observability', 'otlp_exporter', 'endpoint'],
    kind: 'string',
  },
];

/**
 * Apply the env-var overlay to a YAML-parsed config object IN PLACE on a
 * defensive clone. Env values win over YAML values. Unset env vars leave the
 * YAML/default value untouched.
 */
export function applyEnvOverlay(candidate: unknown, env: NodeJS.ProcessEnv): unknown {
  // Only object-shaped candidates can carry overrides. If the YAML produced
  // anything else (null, array, scalar) we hand it to Zod unchanged so the
  // schema can produce a precise validation error.
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return candidate;
  }

  const cloned = structuredClone(candidate) as Record<string, unknown>;

  for (const rule of ENV_OVERLAY_RULES) {
    const raw = env[rule.env];
    if (raw === undefined) continue;
    const value = rule.kind === 'boolean' ? parseBooleanEnv(rule.env, raw) : raw;
    setAtPath(cloned, rule.path, value);
  }

  return cloned;
}

export interface LoadConfigOptions {
  /** Environment to read overrides from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Load and validate the Agent OS config from a YAML file.
 *
 * Pure function: no global state, no caching, no side effects beyond the
 * single synchronous file read.
 *
 * @param path Optional path to a config file. Defaults to
 *   `agent-os.config.yaml` resolved against the current working directory.
 * @param opts Optional overrides. `opts.env` defaults to `process.env` and is
 *   used to apply the documented `AGENT_OS_*` env-var overlay on top of the
 *   YAML before schema validation.
 * @returns A fully-typed, validated `AgentOsConfig`.
 * @throws Error if the file cannot be read, the YAML is malformed, an env-var
 *   override is malformed, or the parsed value fails schema validation.
 */
export function loadConfig(path?: string, opts?: LoadConfigOptions): AgentOsConfig {
  const resolvedPath = resolve(path ?? DEFAULT_CONFIG_FILENAME);
  const env = opts?.env ?? process.env;

  let raw: string;
  try {
    raw = readFileSync(resolvedPath, 'utf8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read Agent OS config at "${resolvedPath}": ${reason}`);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse YAML in Agent OS config "${resolvedPath}": ${reason}`);
  }

  // An empty file yields `undefined`; coerce to `{}` so defaults apply.
  const candidate = parsed ?? {};
  const overlaid = applyEnvOverlay(candidate, env);

  const result = AgentOsConfigSchema.safeParse(overlaid);
  if (!result.success) {
    throw new Error(
      `Invalid Agent OS config at "${resolvedPath}":\n${summarizeZodIssues(result.error)}`,
    );
  }

  return result.data;
}
