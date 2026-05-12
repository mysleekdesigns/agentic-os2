import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { ZodError } from 'zod';
import {
  AgentOsConfigSchema,
  type AgentOsConfig,
} from './schema.js';

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

/**
 * Load and validate the Agent OS config from a YAML file.
 *
 * Pure function: no global state, no caching, no side effects beyond the
 * single synchronous file read.
 *
 * @param path Optional path to a config file. Defaults to
 *   `agent-os.config.yaml` resolved against the current working directory.
 * @returns A fully-typed, validated `AgentOsConfig`.
 * @throws Error if the file cannot be read, the YAML is malformed, or the
 *   parsed value fails schema validation.
 */
export function loadConfig(path?: string): AgentOsConfig {
  const resolvedPath = resolve(path ?? DEFAULT_CONFIG_FILENAME);

  let raw: string;
  try {
    raw = readFileSync(resolvedPath, 'utf8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to read Agent OS config at "${resolvedPath}": ${reason}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to parse YAML in Agent OS config "${resolvedPath}": ${reason}`,
    );
  }

  // An empty file yields `undefined`; coerce to `{}` so defaults apply.
  const candidate = parsed ?? {};

  const result = AgentOsConfigSchema.safeParse(candidate);
  if (!result.success) {
    throw new Error(
      `Invalid Agent OS config at "${resolvedPath}":\n${summarizeZodIssues(
        result.error,
      )}`,
    );
  }

  return result.data;
}
