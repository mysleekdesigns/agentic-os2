# Agent OS — Cloud / Deployment Path (Future)

## Intro

Agent OS today is local-first. This document describes how it could be deployed
as a hosted control plane in the future. No code in this document is shipped
today; the goal is to keep the seams honest so a future port is straightforward.

Phase 16 of the PRD is explicitly framed as future scope. Its exit criterion is
"Documented migration path; no breaking changes to local users." — i.e. this
document. The companion document `docs/deployment.md` (Bundle B) covers the
container image and a minimal compose/deploy recipe.

If you are looking for how Agent OS works today, see `docs/architecture.md`.
If you are looking for the security boundary today, see `docs/security.md` and
`docs/threat-model.md`.

## Compatibility promise

Local users (PRD §1.1, Claude Code Max default path) MUST NOT see breaking
changes from any of the work described here. The three invariants we preserve:

1. `runtime.storage: local_sqlite` keeps working unchanged. SQLite + sqlite-vec
   remain the default and exercised path.
2. `claude_code_local` provider remains the default and zero-API-key path. The
   local CLI never requires `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`.
3. `agent-os.config.yaml` shape is additive — every new field introduced for
   the hosted path defaults to current behavior when absent. A user upgrading
   from a pre-Phase-16 build, without editing their config, sees the same
   runtime they had before.

Anything in this document that would break those invariants is wrong and
should be revised, not shipped.

## Storage abstraction & Postgres + pgvector migration plan

### What's abstracted today

The storage seam is `src/storage/db.ts`. It exports:

- `openDatabase(path, options): AgentOsDb` — the factory.
- `AgentOsDb` — the typed handle returned to callers.

```ts
// src/storage/db.ts (current, abridged)
export type AgentOsDb = BetterSQLite3Database<typeof schema> & {
  $sqlite: BetterSqlite3Database;
};
```

The current alias is specific to better-sqlite3. A future Postgres port has two
viable shapes:

- **Discriminated union**: widen `AgentOsDb` to `SqliteAgentOsDb | PostgresAgentOsDb`,
  each carrying its own raw-handle property (`$sqlite` vs `$pg`). Call sites
  that need raw SQL would narrow on the union.
- **Narrow core interface**: introduce a `AgentOsDbCore` interface that exposes
  only the Drizzle ops we actually use (select/insert/update/delete/transaction),
  and keep the raw-handle access behind a dialect-specific extension. Most
  call sites would type against `AgentOsDbCore`; only the SQLite-specific
  loaders (vec, raw `exec`) would need the wider type.

Sketch of the proposed narrow interface:

```ts
// Proposed (NOT IMPLEMENTED)
export interface AgentOsDbCore {
  // Drizzle query builder surface, dialect-agnostic.
  select: SqliteDb['select'] & PgDb['select'];
  insert: SqliteDb['insert'] & PgDb['insert'];
  update: SqliteDb['update'] & PgDb['update'];
  delete: SqliteDb['delete'] & PgDb['delete'];
  transaction<T>(fn: (tx: AgentOsDbCore) => Promise<T> | T): Promise<T>;
}

export type SqliteAgentOsDb = AgentOsDbCore & { dialect: 'sqlite'; $sqlite: BetterSqlite3Database };
export type PostgresAgentOsDb = AgentOsDbCore & { dialect: 'postgres'; $pg: PgClient };
export type AgentOsDb = SqliteAgentOsDb | PostgresAgentOsDb;
```

In practice the narrower interface is what most of `src/core/**` should depend
on; only the migration runner and the vector loader should care about the
dialect.

### Migration table-by-table

Walking `src/storage/schema.ts`, here is the per-column mapping a Postgres
schema would need. Column names stay identical; only the Drizzle column type
changes. PG types use the `pg-core` package equivalents.

| Table                  | SQLite (current)                                                                                 | Postgres equivalent                                          | Notes                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------- |
| `agents`               | `text` PK, `integer({mode:'timestamp'})`                                                         | `text` PK, `timestamp with time zone`                        | `created_at` semantics unchanged; PG stores tz.                     |
| `runs`                 | `text` PK + FKs, `text` status union, `integer({mode:'timestamp'})`                              | `text` PK + FKs, `text` (CHECK enforces enum), `timestamptz` | Status union stays in TS; CHECK constraint moves verbatim.          |
| `steps`                | same shape as `runs`                                                                             | same shape                                                   | Add a `gin` index on `error` only if we add full-text search later. |
| `tool_calls`           | `text` `risk`, `integer` `latency_ms`                                                            | `text` (CHECK), `integer`                                    | Latency stays integer ms.                                           |
| `approvals`            | `integer({mode:'timestamp'})` for requested/expires/decided                                      | `timestamptz` for all three                                  | NOT NULL + default unchanged.                                       |
| `memory`               | `text` scope/key, `text` value_ref, `integer` revision, `integer({mode:'timestamp'})` deleted_at | `text`, `text`, `integer`, `timestamptz`                     | Add `(scope, key, deleted_at)` partial index for live-row lookups.  |
| `embeddings`           | `blob('vector')`                                                                                 | `vector(N)` from `pgvector`                                  | See pgvector section below. `metadata` `text` → `jsonb`.            |
| `traces`               | `text otel_span_json`                                                                            | `jsonb`                                                      | Lets us query span attributes server-side.                          |
| `eval_results`         | `integer({mode:'boolean'})` `passed`                                                             | `boolean`                                                    | True boolean in PG; the TS surface is unchanged.                    |
| `events`               | `text payload` (JSON-as-text)                                                                    | `jsonb`                                                      | Existing callers already `JSON.parse`; payload shape unchanged.     |
| `_agent_os_migrations` | unchanged                                                                                        | same                                                         | Bookkeeping table.                                                  |

Two cross-cutting notes:

- Everywhere we store JSON inside a `text` column today (`payload`,
  `otel_span_json`, blob refs that hold inline JSON), the PG schema would use
  `jsonb`. The TypeScript surface stays the same (`JSON.parse` on read,
  `JSON.stringify` on write) since Drizzle handles the codec.
- Every `text` status column today is paired with a TS union type and a SQL
  CHECK constraint. The CHECK constraints translate directly to PG.

### pgvector for memory embeddings

`src/storage/vec.ts` is the SQLite-specific path. It loads `sqlite-vec` as an
extension and exposes vector search through a `vec0` virtual table. The
public surface that callers use is `memory.write` (which writes a row to
`memory` and an embedding to `embeddings`) and `searchMemory` (which issues
a similarity query).

For PG, the equivalent stack is `pgvector`:

- `embeddings.vector` becomes a `vector(N)` column where `N` is the embedding
  dimensionality (declared at table-create time).
- The vector index is a `CREATE INDEX ... USING hnsw` (or `ivfflat`) on
  `(vector vector_cosine_ops)`. HNSW is the better default for read-heavy
  workloads; IVF for write-heavy.
- The similarity operator is `<=>` (cosine distance), `<#>` (negative inner
  product), or `<->` (L2). The SQLite path uses cosine via `sqlite-vec`'s
  `vec_distance_cosine`; we'd map to `<=>` on PG.

Dispatch sketch (conceptual — NOT IMPLEMENTED):

```ts
// Proposed dispatch in memory.ts
async function searchMemory(db: AgentOsDb, query: SearchQuery): Promise<MemoryHit[]> {
  if (db.dialect === 'sqlite') {
    return searchMemorySqlite(db, query); // uses vec0 virtual table
  }
  return searchMemoryPostgres(db, query); // uses pgvector <=> operator
}
```

The agent-facing memory API (`memory.write`, `memory.search`, `memory.list`)
does not change. Only the storage adapter swaps.

### Migration runner

Drizzle Kit already supports Postgres. The migration runner (`src/storage/migrate.ts`
and the existing `drizzle/migrations/*.sql` files) is SQL-flavoured for SQLite.
For Postgres we'd:

- Add a `drizzle/migrations-pg/*.sql` sibling directory with PG-dialect DDL.
- Infer the dialect from `runtime.storage` in `agent-os.config.yaml`. A user
  with `local_sqlite` continues to run the existing SQLite migrations; a user
  with `postgres` runs the PG migrations.
- `agent-os migrate` keeps the same CLI surface. No new flag is required;
  the dialect is a config-time decision, not a CLI-time one.

The `_agent_os_migrations` bookkeeping table is dialect-agnostic; both runners
can write to it.

### Backup/restore path

SQLite → Postgres is a one-way migration for any single workspace. The
proposed steps are:

1. `agent-os export --to pgdump > workspace.sql` — emits a `pg_dump`-format
   archive built from the SQLite tables. Blobs are inlined as `bytea`.
2. `psql $TARGET < workspace.sql` — applied to a fresh PG database that has
   already had the PG migrations run.
3. Verify with `agent-os doctor --storage postgres`.

Going the other way (PG → SQLite) is not supported in the initial Phase 16
spec. Hosted users who want to "leave" can `pg_dump` the raw data and a future
import tool can be written if there is demand.

## Workflow engine seam (Inngest / Temporal)

### What's there today

`src/core/tasks/executor.ts` exposes two entry points used by everything else:

- `runWorkflow(opts: RunWorkflowOptions): AsyncIterable<WorkflowEvent>`
- `resumeWorkflow(opts: ResumeWorkflowOptions): AsyncIterable<WorkflowEvent>`

The PRD calls this surface the `WorkflowEngine` interface. The codebase
currently implements the engine inline — there is no formal
`interface WorkflowEngine` symbol exported. State this honestly: the seam is a
pair of functions, not a typed object, and refactoring to a typed interface is
part of the future Phase 16 work.

### Proposed interface

```ts
// Proposed (NOT IMPLEMENTED)
export interface WorkflowEngine {
  /** Start a fresh workflow run. Returns the durable run id. */
  run(input: RunWorkflowOptions): Promise<RunId>;

  /** Resume a paused run after an approval/signal has been resolved. */
  resume(runId: RunId): Promise<void>;

  /** Best-effort cancellation. Idempotent. */
  cancel(runId: RunId): Promise<void>;

  /** Snapshot of the current status without subscribing to events. */
  getStatus(runId: RunId): Promise<RunStatus>;

  /** Subscribe to the live event stream for an in-flight run. */
  subscribe(runId: RunId): AsyncIterable<WorkflowEvent>;
}
```

The existing `runWorkflow` / `resumeWorkflow` become the local in-process
implementation of this interface (`LocalWorkflowEngine`). Hosted deployments
swap in an Inngest- or Temporal-backed implementation.

### Mapping to Inngest

- Each Agent OS workflow step (`StepKind` in `src/storage/schema.ts`: `message`,
  `tool_call`, `approval`, `subagent`, `workflow_step`) becomes an Inngest
  `step.run("<name>", async () => …)` call. Inngest persists each step's
  result and reruns the workflow function deterministically on retry.
- Approval gates (where today `runWorkflow` yields and the executor stores a
  pending `approvals` row) become Inngest `step.waitForEvent("approval.decided",
{ match: "data.approvalId" })`. The dashboard / CLI emits the event when a
  human approves.
- Persistence delegates to Inngest's event store. Agent OS's own `runs` /
  `steps` / `tool_calls` tables become read-only mirrors maintained by an
  event subscriber, so the dashboard, CLI, and existing query patterns keep
  working.
- Concurrency, retries, and idempotency keys move from inline executor code
  to Inngest function config.

### Mapping to Temporal

- Each step becomes a Temporal activity. Activities are the unit of retry and
  durability in Temporal.
- The workflow itself becomes a Temporal workflow function with deterministic
  replay; non-deterministic work (LLM calls, tool execution) lives inside
  activities.
- Approval gates become Temporal **signals**. The workflow `await`s on a
  signal whose payload is the approval decision; the CLI/dashboard sends the
  signal.
- Workflow history is owned by Temporal. As with Inngest, our `runs`/`steps`
  tables are downstream mirrors.

### Why both are listed as "optional"

The PRD frames Inngest/Temporal as optional because most local users will
never need them. A solo developer on Claude Code Max running workflows
against their laptop benefits zero from a durable distributed orchestrator.
The motivating audience is organisations that **already** run Inngest or
Temporal as part of their backend stack and want Agent OS workflows to live
alongside their existing infra. Anyone else should keep the
`LocalWorkflowEngine` (the current inline implementation).

## Container image

See `docs/deployment.md` for the Dockerfile and a minimal docker-compose example.
That document is owned by Bundle B and covers the runtime image, environment
variables, healthcheck endpoint, and the recommended reverse-proxy layout.

## Identity & multi-tenant model spec

This section is the "spec (out of scope for initial release)" line item from
Phase 16. None of it is implemented today.

### Today's tenancy model

Agent OS today is **single-tenant, single-workspace per machine**. The notion
of "tenant" does not exist in the data model. The notion of "workspace" exists
as a filesystem concept (the directory in which `agent-os` is invoked) and is
used by some queries via a `workspace_root` filter, but it is not a row-level
column in most tables. Authentication for the dashboard, when used, is a
single shared bearer token (`AGENT_OS_DASHBOARD_TOKEN`).

### Required identity primitives for a hosted control plane

- **Tenants** — opaque ID, name, created_at. One tenant owns 1..N workspaces.
  A tenant is the billing/legal entity.
- **Users** — opaque ID, primary email, role within tenant. A user can belong
  to multiple tenants via memberships.
- **Workspaces** — `tenant_id` FK, name, created_at. Isolates `agents`,
  `runs`, `approvals`, `memory`, `traces`, `eval_results` rows. The workspace
  is the unit of row-level access control.
- **API tokens / service accounts** — scoped to `(tenant, workspace)`, with
  optional capability allow-list. Used by CI and by automation that cannot
  perform an interactive OAuth login.
- **Sessions** — short-lived bearer tokens issued via OAuth/OIDC. The
  dashboard exchanges an OIDC ID token for a session token at login.

### Schema sketch

**NOT IMPLEMENTED.** This is a sketch only.

```ts
// Proposed identity schema (NOT IMPLEMENTED).
// Conventions match src/storage/schema.ts: text PKs, timestamp columns.

export const tenants = pgTable('tenants', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

export const workspaces = pgTable('workspaces', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id')
    .notNull()
    .references(() => tenants.id),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

export const tenantMemberships = pgTable('tenant_memberships', {
  tenantId: text('tenant_id')
    .notNull()
    .references(() => tenants.id),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  role: text('role').$type<'owner' | 'admin' | 'member'>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

export const apiTokens = pgTable('api_tokens', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id')
    .notNull()
    .references(() => tenants.id),
  workspaceId: text('workspace_id').references(() => workspaces.id),
  hash: text('hash').notNull(), // sha256 of the actual token
  capabilities: text('capabilities'), // JSON array; NULL = full workspace scope
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});
```

### Authorization model

Three scopes, narrowing in privilege:

- **Tenant-scope** — read/write any workspace within the tenant. Typically
  held by tenant `owner` or `admin` memberships and by tenant-level API tokens.
- **Workspace-scope** — read/write a single workspace. The default scope for
  most members and most API tokens.
- **Capability-scope (future)** — per-tool, per-agent. Matches the shape of
  `agents/templates/*.md`'s `tools.allowed`/`tools.approval_required` lists.
  An API token issued with capability-scope can only invoke tools on the
  allow-list, and a tool marked `approval_required` still requires a human
  approval in the workspace's approval queue.

### Authentication transports

- **Local dev** — bearer tokens via `AGENT_OS_DASHBOARD_TOKEN` (already shipped
  in Phase 15). This stays the canonical local path and does not require the
  identity tables above to exist.
- **Hosted** — OIDC (Auth0, Okta, Google Workspace SSO, GitHub OAuth). The
  dashboard exchanges an OIDC ID token for an Agent OS session token. The
  session token is the bearer used on subsequent API calls.
- **CI** — scoped API tokens. Issued from the dashboard, copied into a CI
  secret, used as `Authorization: Bearer <token>` against the Agent OS API.

### Security cross-references

Multi-tenancy compounds the threats already enumerated in `docs/threat-model.md`:

- **Prompt injection** in one tenant must not be able to read another tenant's
  memory or trigger actions in another tenant's workspace. Every memory read,
  tool invocation, and run start must be scoped at the data layer, not relying
  on agent-level "instructions".
- **Tool poisoning** — an MCP server registered in tenant A must not be
  visible to tenant B. The MCP registry becomes a per-workspace concept.
- **Approval queue spoofing** — an approval row carries `(tenant_id,
workspace_id)`; the API must reject decisions submitted by a user whose
  session is for a different scope.

See `docs/security.md` for the current per-process boundary and
`docs/threat-model.md` for the existing STRIDE-style table.

### Row-level isolation

Every query that today filters by `workspace_root` (or filters by nothing,
because there is only one workspace) would gain a `tenant_id` AND
`workspace_id` filter. The tables that grow these columns:

- `agents` — agent definitions are workspace-scoped.
- `runs` — every run belongs to exactly one workspace.
- `steps`, `tool_calls`, `traces`, `eval_results` — inherit workspace via the
  parent run; they could be denormalised with their own `workspace_id` for
  cheap filtering or join through `runs`.
- `approvals` — workspace-scoped; a tenant admin can see all approvals in the
  tenant via a join through `workspaces`.
- `memory`, `embeddings` — workspace-scoped. Cross-workspace memory sharing,
  if ever offered, is opt-in and explicit.
- `events` — workspace-scoped if emitted from workspace activity; tenant-
  scoped for tenant-admin events.
- The hosted PG schema should also add Postgres row-level security (RLS)
  policies as a belt-and-braces guard on top of the application-level
  filters, scoped to the current session's `(tenant_id, workspace_id)`.

### Out of scope (explicit list)

The following are deliberately not part of the multi-tenant spec:

- **Billing / metering hooks** — separate concern, owned by whatever billing
  system the hosted offering picks. Metering can read from the existing
  `runs` / `tool_calls` tables.
- **User invitations + onboarding flows** — productisation surface, not part
  of the core data model.
- **SCIM provisioning** — enterprise-tier feature, added later.
- **GDPR data export** — addressed once the hosted offering exists; the
  `agent-os export` command above is a starting point but the regulatory
  surface (right-to-be-forgotten, data residency) is its own design doc.

## Migration path

Step-by-step plan for an existing local user who wants to deploy to a hosted
control plane. All commands below are future, not currently implemented.

1. **Migrate storage.** Run `agent-os migrate --to postgres
--pg-url postgres://…` against your local SQLite workspace. This applies
   the PG migrations to the target database and copies all rows over. The
   local SQLite file is left untouched as a fallback.
2. **Switch the runtime.** Edit `agent-os.config.yaml`:

   ```yaml
   runtime:
     storage: postgres
     postgres_url: ${AGENT_OS_PG_URL}
   ```

   The default value of `storage` stays `local_sqlite`; setting it to
   `postgres` is opt-in.

3. **Optionally enable a durable workflow engine.** If your org already runs
   Inngest or Temporal:

   ```yaml
   runtime:
     workflow_engine: inngest # or 'temporal' or 'local' (default)
   ```

   `local` keeps the current in-process executor; only flip this if you have
   the infra.

4. **Provision tenant + workspace + tokens.** Use the future admin commands:

   ```sh
   agent-os admin tenant create --name "Acme Inc"
   agent-os admin workspace create --tenant <id> --name "engineering"
   agent-os admin token issue --workspace <id> --capabilities run,approve
   ```

   Distribute the workspace token to CI and the OIDC config to humans.

5. **Deploy the container.** Follow `docs/deployment.md` (Bundle B) for the
   image, healthcheck, and reverse-proxy layout. Point the container at the
   Postgres URL from step 2 and the workflow engine from step 3.

A local user who never wants any of this can ignore steps 1–5 entirely and
keep running `agent-os` against SQLite on their laptop. That is the
compatibility promise.

## Cross-links

- `docs/architecture.md` — current architecture and seams.
- `docs/deployment.md` — Bundle B's container/deployment guide.
- `docs/security.md` — the current per-process security boundary.
- `docs/threat-model.md` — STRIDE-style threats; multi-tenancy compounds
  several of them.
- `docs/memory.md` — memory subsystem; pgvector replaces sqlite-vec under PG.
- `PRD.md` §3 Phase 16 — the PRD framing for cloud/deployment as future
  scope, and the "no breaking changes to local users" exit criterion.
