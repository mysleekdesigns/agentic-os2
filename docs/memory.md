# Agent OS — Memory engine

This document is the source of truth for Phase 7 (Memory system). It mirrors
the style of `docs/security.md` — references point at PRD sections (§n.m)
rather than external URLs.

## What lives where

- **SQLite `memory` table** (canonical index) — `(id, scope, agent_id, key,
value_ref, embedding_id, revision, previous_value_ref, deleted_at,
created_at, updated_at)`. The `deleted_at` column is the authoritative
  live/dead signal (PRD §3 Phase 7: deletes are tombstoned, not destructive).
- **`blobs/` content-addressed store** — every value body is sha256-hashed
  and persisted there. `value_ref` and `previous_value_ref` point in.
- **`<workspaceRoot>/memory/<scope>/<key>.md`** — human-readable mirror of
  the current value, with YAML frontmatter (`id`, `scope`, `key`, `agent_id`,
  `revision`, `created_at`, `updated_at`) and, when `revision > 1`, a one-line
  `<!-- prev: <sha7> -->` comment showing the diff chain.
- **`<workspaceRoot>/memory/MEMORY.md`** — auto-maintained index pattern,
  compatible with Claude Code's conversation-context loader. Capped at 200
  lines. See `agents/templates/MEMORY.md` for the canonical shape.

## Scopes

Scopes are arbitrary strings as of Phase 7. The well-known set is `session`,
`agent`, `project`, `user_preferences` (matching `agent-os.config.yaml ›
memory.default_scopes`); agents may declare their own (e.g. `research_notes`)
in their YAML frontmatter under `memory.read` / `memory.write`. The old
CHECK constraint (`'global'/'agent'/'run'`) is removed by migration
`0004_memory_phase7.sql`.

## Write policy

The engine enforces three rules at the function boundary; the provider
boundary additionally enforces per-agent allow-lists via `policy.ts`.

1. **Append by default.** `createMemory({...})` only inserts when `(scope,
key)` is fresh. A second call with the same key throws `MemoryExistsError`
   — callers MUST use `updateMemory` instead. This prevents silent clobbering
   of accumulated context.
2. **Updates require a diff.** `updateMemory` rejects the default
   `revisionIntent: 'append'`. With `'update'`, the new bytes MUST differ
   from the prior `value_ref`; identical content raises
   `MemoryWritePolicyError`. The new revision's `previous_value_ref` is set
   to the prior `value_ref` so the diff chain is walkable.
3. **Deletes are tombstones.** `removeMemory` sets `deleted_at` (and rewrites
   the file to a single-line `> tombstoned at <ISO>` marker). The row + blob
   are KEPT. Search and `getMemory` filter tombstoned rows by default; pass
   `includeDeleted: true` for audit / forensics.

`revisionIntent: 'overwrite'` exists as an admin / CLI escape hatch — it
skips the differ check and emits `memory.overwritten` instead of
`memory.updated`. Provider-mediated agent calls never set this.

## Diff chain

Each revision points back via `previous_value_ref` (sha256). Walking the
chain reconstructs every version; the blob store keeps every revision
forever (no GC in Phase 7).

## Policy enforcement

`enforceMemoryAccess({ agent, action, scope })` returns `allow` or `deny`.

- `read | list | show | search` → must be in `agent.memory.read`.
- `write | rm` → must be in `agent.memory.write`.

Wildcards are not supported in Phase 7 (revisit in Phase 12 — see PRD).
Every `deny` emits a `memory.denied` row in the `events` table with
`{ agent_id, action, scope, reason, when }`; this is the load-bearing
artefact for the Phase 7 Exit test.

## Search

`searchMemory({ query, embedding? })`:

1. If `embedding` is provided AND sqlite-vec is available → semantic ANN
   via `vec_distance_cosine`, joined to live `memory` rows. Cosine distance
   is mapped to a score in `[0, 1]`.
2. Otherwise → lexical fallback: scan up to 50 most-recently-updated live
   rows, score by case-insensitive token-overlap with the query.

Tombstoned rows are always filtered out.

## MEMORY.md index

Every write touches `<workspaceRoot>/memory/MEMORY.md`. The engine
regenerates the file from the SQLite index (so it always reflects the
authoritative live/dead state) and truncates oldest entries when the line
cap (200) would be exceeded.
