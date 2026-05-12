/**
 * Filesystem loader for Agent OS workflow definitions (PRD §3 Phase 5).
 *
 * Reads a single YAML file or every `*.yaml`/`*.yml` file under a directory,
 * validates against `WorkflowDefSchema`, and hashes the raw bytes so callers
 * can detect content changes without re-parsing. Mirrors the style of
 * `src/core/agents/loader.ts`.
 */

import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { resolve, relative, sep } from 'node:path';

import yaml from 'js-yaml';

import { parseWorkflowDef, WorkflowParseError } from './schema.js';
import type { WorkflowDef } from './types.js';

export interface WorkflowDefinition {
  def: WorkflowDef;
  /** Absolute filesystem path of the YAML file. */
  path: string;
  /** sha256 hex of the raw file bytes. */
  hash: string;
}

/** Error thrown when a workflow file cannot be parsed/validated. */
export class WorkflowLoadError extends Error {
  constructor(
    public readonly file: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(`workflow load failed (${file}): ${message}`);
    this.name = 'WorkflowLoadError';
  }
}

/** Load and validate a single workflow YAML file. */
export async function loadWorkflow(filePath: string): Promise<WorkflowDefinition> {
  const absPath = resolve(filePath);
  const raw = await readFile(absPath);
  const text = raw.toString('utf8');

  let parsed: unknown;
  try {
    parsed = yaml.load(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new WorkflowLoadError(absPath, `invalid YAML: ${msg}`, err);
  }

  if (parsed === null || typeof parsed !== 'object') {
    throw new WorkflowLoadError(absPath, 'workflow file must be a YAML mapping');
  }

  let def: WorkflowDef;
  try {
    def = parseWorkflowDef(parsed);
  } catch (err) {
    if (err instanceof WorkflowParseError) {
      throw new WorkflowLoadError(absPath, err.message, err);
    }
    throw err;
  }

  const hash = createHash('sha256').update(raw).digest('hex');
  return { def, path: absPath, hash };
}

const EXCLUDED_TOP_LEVEL_DIRS = new Set(['examples', 'templates']);

/**
 * Recursively load every `*.yaml` / `*.yml` workflow under `workflowsDir`,
 * skipping `examples/` and `templates/` at the top level.
 *
 * Throws if two workflows share an `id`, naming both files for fast triage.
 */
export async function loadWorkflows(workflowsDir: string): Promise<WorkflowDefinition[]> {
  const root = resolve(workflowsDir);
  const files = await walkYaml(root, root);
  const out: WorkflowDefinition[] = [];
  for (const file of files) {
    out.push(await loadWorkflow(file));
  }

  const byId = new Map<string, string>();
  for (const w of out) {
    const prior = byId.get(w.def.id);
    if (prior !== undefined) {
      throw new WorkflowLoadError(
        w.path,
        `duplicate workflow id "${w.def.id}" already defined at ${prior}`,
      );
    }
    byId.set(w.def.id, w.path);
  }

  return out;
}

async function walkYaml(dir: string, root: string): Promise<string[]> {
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
      const rel = relative(root, full);
      const [topSegment] = rel.split(sep);
      if (topSegment !== undefined && EXCLUDED_TOP_LEVEL_DIRS.has(topSegment)) {
        continue;
      }
      out.push(...(await walkYaml(full, root)));
    } else if (entry.isFile() && (full.endsWith('.yaml') || full.endsWith('.yml'))) {
      out.push(full);
    } else if (entry.isSymbolicLink()) {
      try {
        const s = await stat(full);
        if (s.isFile() && (full.endsWith('.yaml') || full.endsWith('.yml'))) out.push(full);
      } catch {
        // Broken symlinks are silently ignored — surface as missing workflows.
      }
    }
  }

  out.sort();
  return out;
}
