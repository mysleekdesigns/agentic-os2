-- migration: enable sqlite-vec virtual embeddings table (Phase 1 - PRD §2.4)
-- created: 2026-05-12
-- prd-ref: §2.4 / Phase 1
--
-- IRREVERSIBLE: this migration drops the fallback `embeddings` table and
-- replaces it with a vec0 virtual table. Any rows written to the plain
-- fallback table (used when sqlite-vec was unavailable on an earlier boot)
-- are intentionally discarded — the fallback shape cannot hold real vectors
-- anyway, so its data has no semantic value once sqlite-vec is online.
-- Callers must re-embed any memory rows after first successful application.
--
-- This migration is conditional: the runner in `src/storage/migrate.ts` skips
-- it (and records a 'skipped' row in `_agent_os_migrations`) when the
-- sqlite-vec extension is not loadable in the host environment. When the
-- extension becomes available on a later boot, the runner detects the
-- 'skipped' row and retries.

DROP TABLE IF EXISTS embeddings;

CREATE VIRTUAL TABLE IF NOT EXISTS embeddings USING vec0(
  id TEXT PRIMARY KEY,
  vector float[1536],
  metadata TEXT
);
