-- migration: initial schema (Phase 1 - PRD §2.4)
-- created: 2026-05-12
-- prd-ref: §2.4 / Phase 1

-- ---------------------------------------------------------------------------
-- Bookkeeping
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS _agent_os_migrations (
  name        TEXT PRIMARY KEY,
  applied_at  INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'applied'
);

-- ---------------------------------------------------------------------------
-- Core tables (PRD §2.4)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agents (
  id              TEXT PRIMARY KEY,
  version         TEXT NOT NULL,
  definition_path TEXT NOT NULL,
  hash            TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL REFERENCES agents(id),
  workflow_id   TEXT,
  parent_run_id TEXT REFERENCES runs(id),
  status        TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed','cancelled')),
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  summary       TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_agent_id      ON runs(agent_id);
CREATE INDEX IF NOT EXISTS idx_runs_workflow_id   ON runs(workflow_id);
CREATE INDEX IF NOT EXISTS idx_runs_parent_run_id ON runs(parent_run_id);
CREATE INDEX IF NOT EXISTS idx_runs_status        ON runs(status);

CREATE TABLE IF NOT EXISTS steps (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES runs(id),
  kind       TEXT NOT NULL CHECK (kind IN ('message','tool_call','approval','subagent','workflow_step')),
  name       TEXT NOT NULL,
  input_ref  TEXT,
  output_ref TEXT,
  status     TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed','skipped')),
  started_at INTEGER NOT NULL,
  ended_at   INTEGER,
  error      TEXT
);

CREATE INDEX IF NOT EXISTS idx_steps_run_id ON steps(run_id);
CREATE INDEX IF NOT EXISTS idx_steps_status ON steps(status);

CREATE TABLE IF NOT EXISTS tool_calls (
  id           TEXT PRIMARY KEY,
  step_id      TEXT NOT NULL REFERENCES steps(id),
  tool         TEXT NOT NULL,
  args_ref     TEXT,
  result_ref   TEXT,
  risk         TEXT NOT NULL CHECK (risk IN ('read','write','network','shell','destructive')),
  approved_by  TEXT,
  latency_ms   INTEGER,
  status       TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','succeeded','failed'))
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_step_id ON tool_calls(step_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_status  ON tool_calls(status);

CREATE TABLE IF NOT EXISTS approvals (
  id           TEXT PRIMARY KEY,
  run_id       TEXT REFERENCES runs(id),
  step_id      TEXT REFERENCES steps(id),
  requested_by TEXT NOT NULL,
  action       TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','expired')),
  decided_by   TEXT,
  decided_at   INTEGER,
  reason       TEXT
);

CREATE INDEX IF NOT EXISTS idx_approvals_run_id  ON approvals(run_id);
CREATE INDEX IF NOT EXISTS idx_approvals_step_id ON approvals(step_id);
CREATE INDEX IF NOT EXISTS idx_approvals_status  ON approvals(status);

CREATE TABLE IF NOT EXISTS memory (
  id           TEXT PRIMARY KEY,
  scope        TEXT NOT NULL CHECK (scope IN ('global','agent','run')),
  agent_id     TEXT REFERENCES agents(id),
  key          TEXT NOT NULL,
  value_ref    TEXT NOT NULL,
  embedding_id TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_agent_id     ON memory(agent_id);
CREATE INDEX IF NOT EXISTS idx_memory_scope_key    ON memory(scope, key);
CREATE INDEX IF NOT EXISTS idx_memory_embedding_id ON memory(embedding_id);

-- Embeddings: shadow / fallback table when sqlite-vec is unavailable. The
-- virtual `vec0` version is created by `0002_embeddings_vec.sql` *only* when
-- the extension loads. Keeping a plain stub here lets the typed schema
-- compile and lets non-vector callers still insert/read embedding rows by id.
CREATE TABLE IF NOT EXISTS embeddings (
  id       TEXT PRIMARY KEY,
  vector   BLOB,
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS traces (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES runs(id),
  otel_span_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_traces_run_id ON traces(run_id);

CREATE TABLE IF NOT EXISTS eval_results (
  id          TEXT PRIMARY KEY,
  fixture_id  TEXT NOT NULL,
  run_id      TEXT REFERENCES runs(id),
  score       INTEGER NOT NULL,
  passed      INTEGER NOT NULL CHECK (passed IN (0,1)),
  details_ref TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_eval_results_run_id     ON eval_results(run_id);
CREATE INDEX IF NOT EXISTS idx_eval_results_fixture_id ON eval_results(fixture_id);

CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_kind       ON events(kind);
CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);
