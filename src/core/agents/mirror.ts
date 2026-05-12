/**
 * Mirror Agent OS canonical agent files into `.claude/agents/` so Claude
 * Code's native subagent loader can pick them up. PRD §2.6 / Phase 2.
 *
 * The mirror file is identical to the canonical file with one rewrite: a
 * `description` field is synthesized from `role` so Claude Code's auto-
 * delegation has something to match against. Other Agent OS fields are
 * preserved verbatim — Claude Code ignores unknown frontmatter keys (see the
 * `add-agent-template` skill).
 *
 * Mirror cleanup only touches files whose frontmatter carries an Agent OS
 * `id` field; pure Claude Code subagents (no `id`) are left alone.
 */

import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import yaml from 'js-yaml';

import type { AgentDefinition } from './loader.js';

export interface MirrorResult {
  /** Absolute paths of mirror files created or overwritten this run. */
  written: string[];
  /** Absolute paths of mirror files removed because their `id` is no longer in `defs`. */
  removed: string[];
}

const FRONTMATTER_DELIM = /^---\s*\r?\n/;

/**
 * Mirror `defs` into `claudeAgentsDir`. Idempotent.
 *
 * Behaviour:
 * - Writes `<claudeAgentsDir>/<id>.md` for every definition, rewriting the
 *   YAML frontmatter to include a `description` synthesized from `role`.
 * - Removes any `*.md` in the target directory whose frontmatter `id` is not
 *   in `defs`. Files lacking an `id` (= native Claude Code subagents) are
 *   never touched.
 */
export async function mirrorToClaudeAgents(
  defs: AgentDefinition[],
  claudeAgentsDir: string,
): Promise<MirrorResult> {
  const root = resolve(claudeAgentsDir);
  await mkdir(root, { recursive: true });

  const written: string[] = [];
  const removed: string[] = [];

  // 1) Write/overwrite mirror files.
  const wantedIds = new Set<string>();
  for (const def of defs) {
    const id = def.frontmatter.id;
    wantedIds.add(id);
    const target = join(root, `${id}.md`);
    const next = renderMirror(def);

    // Idempotency: skip write when contents already match.
    let current: string | undefined;
    try {
      current = await readFile(target, 'utf8');
    } catch (err) {
      if (
        err === null ||
        typeof err !== 'object' ||
        !('code' in err) ||
        (err as { code?: string }).code !== 'ENOENT'
      ) {
        throw err;
      }
    }
    if (current !== next) {
      await writeFile(target, next, 'utf8');
    }
    written.push(target);
  }

  // 2) Remove orphaned Agent-OS-mirrored files.
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const full = join(root, entry.name);
    const id = await readFrontmatterId(full);
    if (id === undefined) continue; // Not an Agent OS mirror — leave alone.
    if (wantedIds.has(id)) continue;
    await unlink(full);
    removed.push(full);
  }

  return { written, removed };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Re-serialize the canonical definition with a `description` field synthesized
 * from `role`. We preserve insertion order by walking the parsed YAML object
 * and rebuilding it; if `description` was already present on disk we keep the
 * existing value (caller's wishes win over the synthesized default).
 */
function renderMirror(def: AgentDefinition): string {
  const fm = def.frontmatter as unknown as Record<string, unknown>;
  // js-yaml roundtrips with mostly-stable key order via the `sortKeys: false`
  // default, but we want `description` placed near `name` for human review.
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fm)) {
    out[key] = value;
    if (key === 'name' && !('description' in fm)) {
      out.description = def.frontmatter.role;
    }
  }
  if (!('description' in out)) {
    out.description = def.frontmatter.role;
  }

  const yamlText = yaml.dump(out, {
    lineWidth: 100,
    noRefs: true,
    sortKeys: false,
  });
  return `---\n${yamlText}---\n${def.body}`;
}

/**
 * Return the `id` field from the YAML frontmatter of `file`, or undefined if
 * the file has no frontmatter, no id, or fails to parse. Errors are swallowed
 * on purpose — a malformed file should not block cleanup of well-formed ones.
 */
async function readFrontmatterId(file: string): Promise<string | undefined> {
  let text: string;
  try {
    const s = await stat(file);
    if (!s.isFile()) return undefined;
    text = await readFile(file, 'utf8');
  } catch {
    return undefined;
  }

  if (!FRONTMATTER_DELIM.test(text)) return undefined;
  const afterOpen = text.replace(FRONTMATTER_DELIM, '');
  const closeMatch = /\n---\s*(\r?\n|$)/.exec(afterOpen);
  if (!closeMatch) return undefined;
  const yamlText = afterOpen.slice(0, closeMatch.index);

  let parsed: unknown;
  try {
    parsed = yaml.load(yamlText);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const id = (parsed as Record<string, unknown>).id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}
