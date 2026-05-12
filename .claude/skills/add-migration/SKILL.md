---
name: add-migration
description: Author a new Drizzle ORM migration for the Agent OS SQLite database. Trigger when the user asks to "add a migration", "alter the schema", "add a new column", "create a new table for X", or invokes /add-migration. Generates the schema TS edit and the matching SQL migration file, names it correctly, and writes the matching test fixture. Targets PRD §2.4 data model. Does NOT auto-run the migration.
---

# add-migration — Drizzle migration scaffold

You scaffold a Drizzle ORM schema change for the Agent OS project. The canonical data model is **PRD §2.4** and the storage layer convention is **PRD Phase 1**.

## Hard rules

- Read **PRD §2.4** before touching any schema. If the change conflicts with the canonical tables, stop and ask the user — do not silently diverge.
- Driver is `better-sqlite3` unless the user states otherwise (PRD §5).
- Large payloads are stored as content-addressed blobs (`blobs/<sha256>`) and referenced by `*_ref` columns (TEXT, sha256 hex). Never store payloads > 1KB inline.
- Every migration must be reversible OR carry an explicit `-- IRREVERSIBLE: <reason>` comment at the top of the SQL file.
- After scaffolding, do NOT run `drizzle-kit migrate`. Tell the user the file is ready and what command to run.

## Procedure

### Step 1 — Confirm scope

In one sentence, restate what schema change the user is asking for. If they said "add a notes column to runs", state: "Adding `notes TEXT` to `runs` table." If the request is ambiguous (e.g. column type, nullability, default), make the reasonable call from PRD context and state it.

### Step 2 — Read the current schema

- Read `src/storage/schema.ts` (or wherever the Drizzle schema currently lives — check `src/storage/`).
- Read PRD §2.4 to confirm the target table's canonical column list.

If there is no schema file yet (Phase 1 not yet started), say so and ask whether to bootstrap Phase 1's schema first.

### Step 3 — Edit the Drizzle schema

Add or modify the table definition in `src/storage/schema.ts`. Use Drizzle's `better-sqlite3` builder. Conventions:

- Timestamps: `integer({ mode: 'timestamp' })` for unix-epoch seconds.
- Hash refs: `text('input_ref')` — NOT a blob column.
- Foreign keys: `text('run_id').references(() => runs.id)`.
- Add a matching index for every new FK: `index('runs_agent_id_idx').on(table.agent_id)`.
- Status enums: use a TypeScript union and a `CHECK` constraint via raw SQL when needed.

### Step 4 — Generate the SQL migration

- File path: `drizzle/migrations/<NNNN>_<short_slug>.sql` (NNNN = next zero-padded sequence number; check existing files).
- Header comment:
  ```
  -- migration: <short slug>
  -- created: <ISO date>
  -- prd-ref: §2.4 / Phase <N>
  ```
- Write the forward SQL. Use `IF NOT EXISTS` for `CREATE`, never for `ALTER`.
- If the migration is reversible, add a matching `-- ROLLBACK:` block at the bottom (a comment-block — the user runs it manually).
- If irreversible (data destruction), put `-- IRREVERSIBLE: <reason>` at the top.

### Step 5 — sqlite-vec considerations

If the change involves the `embeddings` table or any vector column:
- Use `CREATE VIRTUAL TABLE embeddings USING vec0(...)`.
- Guard the load in code: the schema loader must check whether the `vec0` extension is available and fall back (PRD Phase 1: "fallback for environments without it"). Add a TODO at the top of the migration if this guard does not yet exist.
- The `capabilities.semantic_search` flag in the config must reflect availability.

### Step 6 — Test fixture

Write a Vitest spec at `tests/storage/<table>.test.ts` (or extend an existing one) that:
- Boots an in-memory SQLite DB,
- Runs the migration,
- Inserts a row,
- Reads it back,
- Asserts the round-trip.

Use `:memory:` so the test does not touch the user's local DB.

### Step 7 — Hand off

Print a short summary:
- Schema file edited: `src/storage/schema.ts`
- Migration file created: `drizzle/migrations/<NNNN>_<slug>.sql`
- Test added: `tests/storage/<table>.test.ts`
- Next step: tell the user to run `npm run db:migrate` (or whatever the package.json script is once Phase 1 lands).

Then suggest invoking the `drizzle-schema-reviewer` subagent to audit the change before committing.

## What this skill does not do

- It does NOT run migrations against any database.
- It does NOT modify `agent-os.config.yaml`.
- It does NOT commit code.
