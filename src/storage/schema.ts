/**
 * Drizzle ORM schema for the Agent OS SQLite database.
 *
 * Canonical reference: PRD §2.4 (Phase 1 data model).
 *
 * Conventions:
 * - All timestamps are unix-epoch seconds (`integer({ mode: 'timestamp' })`).
 * - Large payloads live in `blobs/` (content-addressed); columns ending in
 *   `_ref` hold a sha256 hex digest pointing at a blob.
 * - Status enums are expressed as TS unions; CHECK constraints in the raw
 *   SQL migration enforce them at the DB layer.
 * - Every FK column has an accompanying index (defined in raw SQL).
 *
 * Note: the canonical DDL lives in `drizzle/migrations/0001_init.sql`. This
 * file gives us a typed handle for queries and is the source-of-truth for
 * `drizzle-kit` if we ever switch to generated migrations.
 */

import { integer, sqliteTable, text, blob } from 'drizzle-orm/sqlite-core';

// ---------------------------------------------------------------------------
// Status enums (TS-level; CHECK constraints in 0001_init.sql)
// ---------------------------------------------------------------------------

export type RunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

export type StepKind = 'message' | 'tool_call' | 'approval' | 'subagent' | 'workflow_step';

export type ToolCallStatus = 'pending' | 'approved' | 'rejected' | 'succeeded' | 'failed';

export type RiskLevel = 'read' | 'write' | 'network' | 'shell' | 'destructive';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export type MemoryScope = 'global' | 'agent' | 'run';

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/**
 * Registry pointer table. Canonical agent definition remains the YAML/md file
 * on disk; this row tracks version/hash for cache invalidation and audit.
 */
export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  version: text('version').notNull(),
  definitionPath: text('definition_path').notNull(),
  hash: text('hash').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const runs = sqliteTable('runs', {
  id: text('id').primaryKey(),
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id),
  workflowId: text('workflow_id'),
  parentRunId: text('parent_run_id'),
  status: text('status').$type<RunStatus>().notNull(),
  startedAt: integer('started_at', { mode: 'timestamp' }).notNull(),
  endedAt: integer('ended_at', { mode: 'timestamp' }),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  summary: text('summary'),
});

export const steps = sqliteTable('steps', {
  id: text('id').primaryKey(),
  runId: text('run_id')
    .notNull()
    .references(() => runs.id),
  kind: text('kind').$type<StepKind>().notNull(),
  name: text('name').notNull(),
  inputRef: text('input_ref'),
  outputRef: text('output_ref'),
  status: text('status').$type<StepStatus>().notNull(),
  startedAt: integer('started_at', { mode: 'timestamp' }).notNull(),
  endedAt: integer('ended_at', { mode: 'timestamp' }),
  error: text('error'),
});

export const toolCalls = sqliteTable('tool_calls', {
  id: text('id').primaryKey(),
  stepId: text('step_id')
    .notNull()
    .references(() => steps.id),
  tool: text('tool').notNull(),
  argsRef: text('args_ref'),
  resultRef: text('result_ref'),
  risk: text('risk').$type<RiskLevel>().notNull(),
  approvedBy: text('approved_by'),
  latencyMs: integer('latency_ms'),
  status: text('status').$type<ToolCallStatus>().notNull(),
});

export const approvals = sqliteTable('approvals', {
  id: text('id').primaryKey(),
  runId: text('run_id').references(() => runs.id),
  stepId: text('step_id').references(() => steps.id),
  requestedBy: text('requested_by').notNull(),
  action: text('action').notNull(),
  status: text('status').$type<ApprovalStatus>().notNull(),
  decidedBy: text('decided_by'),
  decidedAt: integer('decided_at', { mode: 'timestamp' }),
  reason: text('reason'),
});

export const memory = sqliteTable('memory', {
  id: text('id').primaryKey(),
  scope: text('scope').$type<MemoryScope>().notNull(),
  agentId: text('agent_id').references(() => agents.id),
  key: text('key').notNull(),
  valueRef: text('value_ref').notNull(),
  embeddingId: text('embedding_id'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

/**
 * Embeddings are stored in a `vec0` virtual table when `sqlite-vec` is
 * available. We model a plain shadow row here so that Drizzle can issue
 * typed queries against the metadata even if the vector column is opaque.
 *
 * The `vector` column type is BLOB at the SQL level (vec0 accepts blob
 * input). On environments without sqlite-vec the table is created as a
 * regular table with the same column shape so basic CRUD still works for
 * tests; only similarity search is unavailable.
 */
export const embeddings = sqliteTable('embeddings', {
  id: text('id').primaryKey(),
  vector: blob('vector'),
  metadata: text('metadata'),
});

export const traces = sqliteTable('traces', {
  id: text('id').primaryKey(),
  runId: text('run_id')
    .notNull()
    .references(() => runs.id),
  otelSpanJson: text('otel_span_json').notNull(),
});

export const evalResults = sqliteTable('eval_results', {
  id: text('id').primaryKey(),
  fixtureId: text('fixture_id').notNull(),
  runId: text('run_id').references(() => runs.id),
  score: integer('score').notNull(),
  passed: integer('passed', { mode: 'boolean' }).notNull(),
  detailsRef: text('details_ref'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const events = sqliteTable('events', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  payload: text('payload').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

/**
 * Bookkeeping table tracking which migrations have been applied.
 * Managed by `src/storage/migrate.ts`; not part of §2.4.
 */
export const _agentOsMigrations = sqliteTable('_agent_os_migrations', {
  name: text('name').primaryKey(),
  appliedAt: integer('applied_at', { mode: 'timestamp' }).notNull(),
  status: text('status').notNull(),
});

// ---------------------------------------------------------------------------
// Inferred row types — convenient for callers building typed records.
// ---------------------------------------------------------------------------

export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
export type Step = typeof steps.$inferSelect;
export type NewStep = typeof steps.$inferInsert;
export type ToolCall = typeof toolCalls.$inferSelect;
export type NewToolCall = typeof toolCalls.$inferInsert;
export type Approval = typeof approvals.$inferSelect;
export type NewApproval = typeof approvals.$inferInsert;
export type Memory = typeof memory.$inferSelect;
export type NewMemory = typeof memory.$inferInsert;
export type Embedding = typeof embeddings.$inferSelect;
export type NewEmbedding = typeof embeddings.$inferInsert;
export type Trace = typeof traces.$inferSelect;
export type NewTrace = typeof traces.$inferInsert;
export type EvalResult = typeof evalResults.$inferSelect;
export type NewEvalResult = typeof evalResults.$inferInsert;
export type EventRow = typeof events.$inferSelect;
export type NewEventRow = typeof events.$inferInsert;
