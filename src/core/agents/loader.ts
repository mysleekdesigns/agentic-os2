/**
 * Filesystem loader for Agent OS agent definitions.
 *
 * Walks an agents directory, splits the YAML frontmatter from the markdown
 * body, validates against `AgentFrontmatterSchema`, and hashes the raw bytes
 * so callers can detect content changes without re-parsing.
 *
 * Excludes `agents/templates/` and `agents/examples/` — those are starter
 * material per PRD Phase 2 and are not registered as live agents.
 *
 * Canonical reference: PRD §2.6.
 */

import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { resolve, sep, basename, relative } from 'node:path';

import yaml from 'js-yaml';
import { ZodError } from 'zod';

import { AgentFrontmatterSchema, type AgentFrontmatter } from './schema.js';

export interface AgentDefinition {
  frontmatter: AgentFrontmatter;
  /** Raw markdown body after the closing `---` delimiter. */
  body: string;
  /** Absolute filesystem path of the canonical file. */
  path: string;
  /** sha256 hex of the entire file's raw bytes (frontmatter + body). */
  hash: string;
}

/** Error thrown when an agent file cannot be parsed/validated. */
export class AgentLoadError extends Error {
  constructor(
    public readonly file: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(`agent load failed (${file}): ${message}`);
    this.name = 'AgentLoadError';
  }
}

const FRONTMATTER_DELIM = /^---\s*\r?\n/;

/**
 * Load and validate a single agent definition file.
 *
 * Frontmatter is the YAML block delimited by two `---` lines starting at the
 * very first byte. The markdown body is everything after the second delimiter
 * (verbatim, including any trailing newline).
 */
export async function loadAgent(filePath: string): Promise<AgentDefinition> {
  const absPath = resolve(filePath);
  const raw = await readFile(absPath);
  const text = raw.toString('utf8');

  if (!FRONTMATTER_DELIM.test(text)) {
    throw new AgentLoadError(absPath, 'missing leading `---` frontmatter delimiter');
  }

  // Strip the opening delimiter, then find the closing one.
  const afterOpen = text.replace(FRONTMATTER_DELIM, '');
  const closeMatch = /\n---\s*(\r?\n|$)/.exec(afterOpen);
  if (!closeMatch) {
    throw new AgentLoadError(absPath, 'missing closing `---` frontmatter delimiter');
  }
  const yamlText = afterOpen.slice(0, closeMatch.index);
  const body = afterOpen.slice(closeMatch.index + closeMatch[0].length);

  let parsed: unknown;
  try {
    parsed = yaml.load(yamlText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AgentLoadError(absPath, `invalid YAML frontmatter: ${msg}`, err);
  }

  if (parsed === null || typeof parsed !== 'object') {
    throw new AgentLoadError(absPath, 'frontmatter must be a YAML mapping');
  }

  let frontmatter: AgentFrontmatter;
  try {
    frontmatter = AgentFrontmatterSchema.parse(parsed);
  } catch (err) {
    if (err instanceof ZodError) {
      const summary = err.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ');
      throw new AgentLoadError(absPath, `schema validation failed: ${summary}`, err);
    }
    throw err;
  }

  const hash = createHash('sha256').update(raw).digest('hex');

  return { frontmatter, body, path: absPath, hash };
}

/**
 * Recursively load every `*.md` agent file under `agentsDir`, skipping the
 * `templates/` and `examples/` subdirectories (starter material).
 *
 * Throws if two definitions share an `id`, naming both files for fast triage.
 */
export async function loadAgents(agentsDir: string): Promise<AgentDefinition[]> {
  const root = resolve(agentsDir);
  const files = await walkMarkdown(root, root);
  const defs: AgentDefinition[] = [];
  for (const file of files) {
    defs.push(await loadAgent(file));
  }

  const byId = new Map<string, string>();
  for (const def of defs) {
    const prior = byId.get(def.frontmatter.id);
    if (prior !== undefined) {
      throw new AgentLoadError(
        def.path,
        `duplicate agent id "${def.frontmatter.id}" already defined at ${prior}`,
      );
    }
    byId.set(def.frontmatter.id, def.path);
  }

  return defs;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const EXCLUDED_TOP_LEVEL_DIRS = new Set(['templates', 'examples']);

/** Depth-first walk yielding absolute paths of `*.md` files under `root`. */
async function walkMarkdown(dir: string, root: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = (await readdir(dir, { withFileTypes: true })) as unknown as Dirent[];
  } catch (err) {
    if (
      err !== null &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: string }).code === 'ENOENT'
    ) {
      return [];
    }
    throw err;
  }

  const out: string[] = [];
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      // Excluded only when the directory is a direct child of the root —
      // a deeper `notes/templates/` should still be walked.
      const rel = relative(root, full);
      const [topSegment] = rel.split(sep);
      if (topSegment !== undefined && EXCLUDED_TOP_LEVEL_DIRS.has(topSegment)) {
        continue;
      }
      out.push(...(await walkMarkdown(full, root)));
    } else if (entry.isFile() && full.endsWith('.md')) {
      out.push(full);
    } else if (entry.isSymbolicLink()) {
      // Follow only if it points at a regular file with a .md suffix.
      try {
        const s = await stat(full);
        if (s.isFile() && full.endsWith('.md')) out.push(full);
      } catch {
        // Broken symlinks are silently ignored — they show up in the build
        // output as missing agents, which is a clearer signal than a crash.
      }
    }
  }

  // Stable ordering across platforms so duplicate-id errors are deterministic.
  out.sort();
  return out;
}

// Exported for tests that want to assert the "templates/examples are skipped"
// behaviour against the actual basename check (kept module-private otherwise).
export const _internal = { EXCLUDED_TOP_LEVEL_DIRS, basename };
