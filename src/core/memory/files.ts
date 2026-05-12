/**
 * File-backed memory storage (PRD §3 Phase 7).
 *
 * Memory lives on disk at `<workspaceRoot>/memory/<scope>/<key>.md` so a human
 * reading the directory tree sees the same content the executor sees through
 * the SQLite index. The SQLite `memory` row is the authoritative live/dead
 * signal (via `deleted_at`); the files are mirrored markdown.
 *
 * Each file has YAML frontmatter:
 *
 *   ---
 *   id: <memory id>
 *   scope: <scope>
 *   key: <key>
 *   agent_id: <agent id or null>
 *   revision: <int>
 *   created_at: <ISO>
 *   updated_at: <ISO>
 *   ---
 *   <markdown body>
 *
 * When a write produces a revision > 1, a single `<!-- prev: <sha7> -->`
 * comment is inserted under the frontmatter so the diff chain is visible to
 * humans without consulting the database.
 *
 * The `MEMORY.md` index at the workspace root memory directory is maintained
 * here too: each create / update / remove call appends or rewrites a single
 * line under a `## <scope>` section. The index is trimmed to ≤200 lines.
 */

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

export interface MemoryFileMeta {
  id: string;
  scope: string;
  key: string;
  agentId: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
  /** Optional sha256 of the prior value blob; renders as a `<!-- prev: -->`
   *  comment when present. */
  previousValueRef?: string | null;
}

export interface WriteMemoryFileArgs extends MemoryFileMeta {
  workspaceRoot: string;
  value: string;
}

export interface ReadMemoryFileArgs {
  workspaceRoot: string;
  scope: string;
  key: string;
}

export interface RemoveMemoryFileArgs {
  workspaceRoot: string;
  scope: string;
  key: string;
  /** ISO timestamp written into the tombstone marker. */
  tombstonedAt: string;
}

/**
 * Sanitize a key into a filesystem-safe slug:
 *   - Lowercased.
 *   - Runs of non-alphanumerics collapsed to `-`.
 *   - Leading / trailing `-` trimmed.
 *   - Empty result rejected.
 *
 * @throws Error on empty / unsanitizable input.
 */
export function sanitizeKey(key: string): string {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('memory key must be a non-empty string');
  }
  const slug = key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length === 0) {
    throw new Error(`memory key produced an empty slug: ${key}`);
  }
  return slug;
}

/**
 * Sanitize a scope name similarly. Empty scopes are rejected so the directory
 * resolver can't accidentally land on the memory root.
 */
export function sanitizeScope(scope: string): string {
  if (typeof scope !== 'string' || scope.length === 0) {
    throw new Error('memory scope must be a non-empty string');
  }
  const slug = scope
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length === 0) {
    throw new Error(`memory scope produced an empty slug: ${scope}`);
  }
  return slug;
}

function memoryRoot(workspaceRoot: string): string {
  return resolve(workspaceRoot, 'memory');
}

/**
 * Resolve a memory file path, guarding against `..` traversal. The returned
 * path is always inside `<workspaceRoot>/memory/<scope>/`.
 */
export function memoryFilePath(workspaceRoot: string, scope: string, key: string): string {
  const root = memoryRoot(workspaceRoot);
  const scopeDir = resolve(root, sanitizeScope(scope));
  const file = resolve(scopeDir, `${sanitizeKey(key)}.md`);
  // Defence-in-depth: the sanitizer already strips `..` but verify the resolved
  // path remains under the scope directory.
  if (!file.startsWith(scopeDir + sep) && file !== scopeDir) {
    throw new Error(`memory key resolves outside scope directory: ${key}`);
  }
  return file;
}

function isoFromSeconds(s: number): string {
  return new Date(s * 1000).toISOString();
}

function renderFrontmatter(meta: MemoryFileMeta, value: string): string {
  const lines: string[] = [
    '---',
    `id: ${meta.id}`,
    `scope: ${meta.scope}`,
    `key: ${meta.key}`,
    `agent_id: ${meta.agentId ?? 'null'}`,
    `revision: ${meta.revision}`,
    `created_at: ${isoFromSeconds(meta.createdAt)}`,
    `updated_at: ${isoFromSeconds(meta.updatedAt)}`,
    '---',
  ];
  if (meta.revision > 1 && meta.previousValueRef) {
    lines.push(`<!-- prev: ${meta.previousValueRef.slice(0, 7)} -->`);
  }
  lines.push('');
  lines.push(value);
  if (!value.endsWith('\n')) lines.push('');
  return lines.join('\n');
}

/**
 * Write (or rewrite) the markdown file for a memory entry. Creates the scope
 * directory on demand. Returns the absolute path.
 */
export async function writeMemoryFile(args: WriteMemoryFileArgs): Promise<string> {
  const path = memoryFilePath(args.workspaceRoot, args.scope, args.key);
  await mkdir(dirname(path), { recursive: true });
  const meta: MemoryFileMeta = {
    id: args.id,
    scope: args.scope,
    key: args.key,
    agentId: args.agentId,
    revision: args.revision,
    createdAt: args.createdAt,
    updatedAt: args.updatedAt,
    previousValueRef: args.previousValueRef ?? null,
  };
  await writeFile(path, renderFrontmatter(meta, args.value), 'utf8');
  return path;
}

/**
 * Read the full file contents (frontmatter + body) for a memory entry.
 * Returns `null` if the file does not exist.
 */
export async function readMemoryFile(args: ReadMemoryFileArgs): Promise<string | null> {
  const path = memoryFilePath(args.workspaceRoot, args.scope, args.key);
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if (
      err !== null &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: string }).code === 'ENOENT'
    ) {
      return null;
    }
    throw err;
  }
}

/**
 * Rewrite the file as a one-line tombstone marker. The SQLite `deleted_at`
 * column is the authoritative live/dead signal — this is just so humans
 * browsing `memory/` see the state.
 */
export async function removeMemoryFile(args: RemoveMemoryFileArgs): Promise<string> {
  const path = memoryFilePath(args.workspaceRoot, args.scope, args.key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `> tombstoned at ${args.tombstonedAt}\n`, 'utf8');
  return path;
}

// ---------------------------------------------------------------------------
// MEMORY.md index maintenance
// ---------------------------------------------------------------------------

export interface UpdateMemoryIndexArgs {
  workspaceRoot: string;
  entries: Array<{
    scope: string;
    key: string;
    /** Free-form one-line hook shown next to the file link. */
    hook: string;
    /** Live / tombstoned indicator. */
    state: 'live' | 'tombstoned';
  }>;
}

const MEMORY_INDEX_MAX_LINES = 200;

/**
 * Regenerate `<workspaceRoot>/memory/MEMORY.md` from the provided entries.
 * Entries are grouped by scope. The total file length is capped at
 * `MEMORY_INDEX_MAX_LINES` — older entries (passed later in the array) are
 * truncated when the cap would be exceeded.
 *
 * Callers compute `entries` from the SQLite index (so the file always
 * reflects authoritative live/dead state). This function does not touch
 * the database itself.
 */
export async function writeMemoryIndex(args: UpdateMemoryIndexArgs): Promise<string> {
  const root = memoryRoot(args.workspaceRoot);
  await mkdir(root, { recursive: true });
  const indexPath = join(root, 'MEMORY.md');

  const byScope = new Map<
    string,
    Array<{ key: string; hook: string; state: 'live' | 'tombstoned' }>
  >();
  for (const e of args.entries) {
    const list = byScope.get(e.scope) ?? [];
    list.push({ key: e.key, hook: e.hook, state: e.state });
    byScope.set(e.scope, list);
  }

  const header: string[] = [
    '# MEMORY.md',
    '',
    '> Agent OS memory index — auto-maintained by `src/core/memory/files.ts`.',
    '> Edit `<workspaceRoot>/memory/<scope>/<key>.md` directly to change a',
    '> memory; this file is regenerated on every create / update / remove.',
    '',
  ];

  const body: string[] = [];
  for (const scope of Array.from(byScope.keys()).sort()) {
    body.push(`## ${scope}`);
    body.push('');
    for (const entry of byScope.get(scope)!) {
      const marker = entry.state === 'tombstoned' ? ' _(tombstoned)_' : '';
      const safeKey = sanitizeKey(entry.key);
      body.push(
        `- [${entry.key}](./${sanitizeScope(scope)}/${safeKey}.md) — ${entry.hook}${marker}`,
      );
    }
    body.push('');
  }

  const all = [...header, ...body];
  const truncated =
    all.length > MEMORY_INDEX_MAX_LINES
      ? [...all.slice(0, MEMORY_INDEX_MAX_LINES - 1), '<!-- truncated: older entries omitted -->']
      : all;

  await writeFile(indexPath, truncated.join('\n') + '\n', 'utf8');
  return indexPath;
}

/**
 * Convenience helper: enumerate the markdown files currently sitting under
 * `<workspaceRoot>/memory/`. Used by tests + introspection; the engine writes
 * the index from DB state, not from disk.
 */
export async function listMemoryFiles(workspaceRoot: string): Promise<string[]> {
  const root = memoryRoot(workspaceRoot);
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const out: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const scopeDir = join(root, e.name);
      const files = await readdir(scopeDir);
      for (const f of files) {
        if (f.endsWith('.md')) {
          const full = join(scopeDir, f);
          const s = await stat(full);
          if (s.isFile()) out.push(full);
        }
      }
    }
    return out;
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
}
