-- migration: approvals TTL + reviewer note + revised_action
-- created: 2026-05-12
-- prd-ref: §3 Phase 6 (human approval system)
--
-- Adds the columns needed by the approval queue:
--   - requested_at  unix epoch seconds (NOT NULL; new inserts must populate it).
--                   Backfilled to 0 for any pre-existing rows so the NOT NULL
--                   constraint can be added in-place.
--   - expires_at    optional deadline (NULL = never expires). Index added so
--                   the lazy expirer can sweep due rows efficiently.
--   - note          optional reviewer note attached on approve/reject/revise.
--   - revised_action  populated when a reviewer issues a "revise" decision.
--
-- Semantics — "revise":
--   We deliberately do NOT add a `revised` status (the CHECK constraint stays
--   stable: pending/approved/rejected/expired). A revise decision keeps
--   status='pending' but records the new action in `revised_action` plus a
--   note + decided_by + decided_at. A downstream approve/reject then acts on
--   the revised action.
--
-- Reversible: see ROLLBACK block at the bottom.

ALTER TABLE approvals ADD COLUMN requested_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE approvals ADD COLUMN expires_at   INTEGER;
ALTER TABLE approvals ADD COLUMN note         TEXT;
ALTER TABLE approvals ADD COLUMN revised_action TEXT;

CREATE INDEX IF NOT EXISTS idx_approvals_expires_at ON approvals(expires_at);

-- ROLLBACK:
-- DROP INDEX IF EXISTS idx_approvals_expires_at;
-- -- SQLite < 3.35 cannot DROP COLUMN; rebuild the table to revert:
-- BEGIN;
-- CREATE TABLE approvals_old AS SELECT
--   id, run_id, step_id, requested_by, action, status, decided_by, decided_at, reason
-- FROM approvals;
-- DROP TABLE approvals;
-- ALTER TABLE approvals_old RENAME TO approvals;
-- -- (re-create the original CHECK + indexes from 0001_init.sql)
-- COMMIT;
