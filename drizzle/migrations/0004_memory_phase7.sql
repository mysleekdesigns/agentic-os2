-- migration: memory engine — Phase 7 (scopes + diff chain + tombstones)
-- created: 2026-05-12
-- prd-ref: §3 Phase 7
--
-- SQLite cannot DROP a CHECK constraint via ALTER, so this migration rebuilds
-- the `memory` table:
--   * Drops the legacy `scope IN ('global','agent','run')` CHECK so arbitrary
--     named scopes are permitted (PRD §3 Phase 7 — session / agent / project /
--     user_preferences plus any agent-declared scope).
--   * Adds:
--       deleted_at         INTEGER NULL    -- non-NULL = tombstoned (live=NULL)
--       revision           INTEGER NOT NULL DEFAULT 1
--       previous_value_ref TEXT NULL       -- diff chain: prior value blob hash
--
-- Data preservation: existing rows are copied 1:1, deleted_at=NULL,
-- revision=1, previous_value_ref=NULL. Indexes from 0001_init.sql are
-- recreated plus a new idx_memory_deleted_at for tombstone filtering.
--
-- Reversible: see ROLLBACK block at the bottom.
--
-- Note: the migrate runner wraps each migration file in its own
-- BEGIN/COMMIT transaction, so this SQL deliberately omits an outer
-- transaction block (SQLite forbids nested transactions).

ALTER TABLE memory RENAME TO memory_old;

CREATE TABLE memory (
  id                 TEXT PRIMARY KEY,
  scope              TEXT NOT NULL,
  agent_id           TEXT REFERENCES agents(id),
  key                TEXT NOT NULL,
  value_ref          TEXT NOT NULL,
  embedding_id       TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  deleted_at         INTEGER,
  revision           INTEGER NOT NULL DEFAULT 1,
  previous_value_ref TEXT
);

INSERT INTO memory (
  id, scope, agent_id, key, value_ref, embedding_id,
  created_at, updated_at, deleted_at, revision, previous_value_ref
)
SELECT
  id, scope, agent_id, key, value_ref, embedding_id,
  created_at, updated_at, NULL, 1, NULL
FROM memory_old;

DROP TABLE memory_old;

CREATE INDEX IF NOT EXISTS idx_memory_agent_id     ON memory(agent_id);
CREATE INDEX IF NOT EXISTS idx_memory_scope_key    ON memory(scope, key);
CREATE INDEX IF NOT EXISTS idx_memory_embedding_id ON memory(embedding_id);
CREATE INDEX IF NOT EXISTS idx_memory_deleted_at   ON memory(deleted_at);

-- ROLLBACK:
-- BEGIN;
-- ALTER TABLE memory RENAME TO memory_new;
-- CREATE TABLE memory (
--   id           TEXT PRIMARY KEY,
--   scope        TEXT NOT NULL CHECK (scope IN ('global','agent','run')),
--   agent_id     TEXT REFERENCES agents(id),
--   key          TEXT NOT NULL,
--   value_ref    TEXT NOT NULL,
--   embedding_id TEXT,
--   created_at   INTEGER NOT NULL,
--   updated_at   INTEGER NOT NULL
-- );
-- INSERT INTO memory (id, scope, agent_id, key, value_ref, embedding_id, created_at, updated_at)
--   SELECT id, scope, agent_id, key, value_ref, embedding_id, created_at, updated_at
--   FROM memory_new
--   WHERE deleted_at IS NULL
--     AND scope IN ('global','agent','run');
-- DROP TABLE memory_new;
-- CREATE INDEX IF NOT EXISTS idx_memory_agent_id     ON memory(agent_id);
-- CREATE INDEX IF NOT EXISTS idx_memory_scope_key    ON memory(scope, key);
-- CREATE INDEX IF NOT EXISTS idx_memory_embedding_id ON memory(embedding_id);
-- COMMIT;
