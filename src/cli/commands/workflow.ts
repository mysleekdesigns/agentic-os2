/**
 * `agent-os workflow` command group: lists workflow YAML definitions, runs /
 * resumes / cancels / inspects workflow runs.
 *
 * Wire-up:
 *   1. Workflow files live under `<workspace>/workflows/` (recursively,
 *      excluding `workflows/templates/`). `workflows/examples/` IS included
 *      since the loader excludes it at the top level — we re-load it
 *      separately and merge so example workflows are runnable end-to-end.
 *   2. Run / resume execute via `runWorkflow` / `resumeWorkflow` from the
 *      task engine. The engine takes a `ProviderAdapter` so we hand it a
 *      thin shim that delegates to `getProvider(providerId)` and aggregates
 *      `message` events into the step's textual output.
 *   3. Streamed `WorkflowEvent`s are rendered one-per-line (pretty by default,
 *      JSONL with `--json`).
 *   4. Exit codes:
 *        completed → 0
 *        cancelled (SIGINT) → 130
 *        failed OR paused (approval / wait_event) → 1
 *      Paused is intentionally NOT a success — the user must resume.
 *
 * Local-first: no API-key reads. The provider adapter goes through the
 * provider registry, which tests populate with a `FakeProvider`.
 *
 * Canonical reference: PRD §3 Phase 5.
 */

import { randomUUID } from 'node:crypto';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { Command } from 'commander';
import { and, eq } from 'drizzle-orm';

import { loadConfig } from '../../config/index.js';
import {
  loadWorkflows,
  type WorkflowDefinition,
  runWorkflow,
  resumeWorkflow,
  cancelWorkflow,
  type ProviderAdapter,
  type ProviderAdapterInput,
  type ApprovalResolver,
  type WorkflowEvent,
  type StepDef,
  type AgentStepDef,
} from '../../core/tasks/index.js';
import {
  ensureBuiltinProvidersRegistered,
  getProvider,
  hasProvider,
  type AgentRunInput,
  type ProviderId,
  type RunEvent,
} from '../../core/providers/index.js';
import { openDatabase, type AgentOsDb } from '../../storage/db.js';
import { runMigrations } from '../../storage/migrate.js';
import { createBlobStore } from '../../storage/blobs.js';
import { agents, approvals, runs, steps } from '../../storage/schema.js';

// ---------------------------------------------------------------------------
// Workspace / DB helpers (mirrors agent.ts + run.ts conventions)
// ---------------------------------------------------------------------------

function resolveWorkspaceRoot(cwd: string): string {
  const config = loadConfig(undefined, { env: process.env });
  const raw = config.runtime.workspace_root;
  return isAbsolute(raw) ? raw : resolve(cwd, raw);
}

function defaultDbPath(workspace: string): string {
  // Match `run.ts`'s defaultAuditorFactory: `<workspace>/.agent-os/db.sqlite`.
  return process.env.AGENT_OS_DB ?? join(workspace, '.agent-os', 'db.sqlite');
}

function workflowsDir(workspace: string): string {
  return join(workspace, 'workflows');
}

function examplesDir(workspace: string): string {
  return join(workspace, 'workflows', 'examples');
}

/**
 * Load every workflow under `workflows/` (recursively) AND every workflow
 * directly under `workflows/examples/`. The base loader excludes the
 * `examples/` top-level dir, so we call it twice and dedupe by absolute path.
 */
async function loadAllWorkflows(workspace: string): Promise<WorkflowDefinition[]> {
  const main = await loadWorkflows(workflowsDir(workspace));
  let examples: WorkflowDefinition[] = [];
  try {
    examples = await loadWorkflows(examplesDir(workspace));
  } catch {
    // No examples dir, or load error — treat as empty so the main set still works.
    examples = [];
  }
  const byPath = new Map<string, WorkflowDefinition>();
  for (const w of [...main, ...examples]) {
    byPath.set(w.path, w);
  }
  // Detect duplicate ids across the merged set (would otherwise silently
  // shadow). The base loader detects within a single call only.
  const byId = new Map<string, string>();
  for (const w of byPath.values()) {
    const prior = byId.get(w.def.id);
    if (prior !== undefined && prior !== w.path) {
      throw new Error(
        `duplicate workflow id "${w.def.id}" in ${w.path} (already defined at ${prior})`,
      );
    }
    byId.set(w.def.id, w.path);
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

// ---------------------------------------------------------------------------
// Table formatter (copied from agent.ts to keep the look consistent)
// ---------------------------------------------------------------------------

function formatTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((h, col) => {
    let w = h.length;
    for (const row of rows) {
      const cell = row[col] ?? '';
      if (cell.length > w) w = cell.length;
    }
    return w;
  });
  const pad = (cells: readonly string[]) =>
    cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!))).join('  ');
  const lines: string[] = [];
  lines.push(pad(headers));
  for (const row of rows) lines.push(pad(row));
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// `workflow list`
// ---------------------------------------------------------------------------

interface ListJsonRow {
  id: string;
  version: number;
  description: string | null;
  path: string;
  hash: string;
}

interface ListCliOptions {
  json?: boolean;
}

function toListRow(workspace: string, w: WorkflowDefinition): ListJsonRow {
  return {
    id: w.def.id,
    version: w.def.version,
    description: w.def.description ?? null,
    path: relative(workspace, w.path) || w.path,
    hash: w.hash,
  };
}

async function runList(cwd: string, opts: ListCliOptions): Promise<void> {
  const workspace = resolveWorkspaceRoot(cwd);
  const defs = await loadAllWorkflows(workspace);

  if (opts.json) {
    process.stdout.write(JSON.stringify(defs.map((d) => toListRow(workspace, d))) + '\n');
    return;
  }

  if (defs.length === 0) {
    process.stdout.write(`No workflows found in ${workflowsDir(workspace)}\n`);
    return;
  }

  const rows = defs.map((d) => [
    d.def.id,
    String(d.def.version),
    relative(cwd, d.path) || d.path,
    d.def.description ?? '',
  ]);
  process.stdout.write(formatTable(['ID', 'VERSION', 'PATH', 'DESCRIPTION'], rows));
}

// ---------------------------------------------------------------------------
// Event rendering (pretty + JSONL)
// ---------------------------------------------------------------------------

function oneLine(value: unknown): string {
  if (value === undefined) return '';
  try {
    return JSON.stringify(value).replace(/\s+/g, ' ');
  } catch {
    return '<unserialisable>';
  }
}

function renderWorkflowEvent(ev: WorkflowEvent): string {
  switch (ev.type) {
    case 'step_started':
      return `  → step_started ${ev.stepId} (${ev.kind})`;
    case 'step_completed': {
      const out = ev.output === undefined ? '' : ` output=${oneLine(ev.output)}`;
      return `  ✓ step_completed ${ev.stepId} (${ev.kind})${out}`;
    }
    case 'step_failed':
      return `  ✗ step_failed ${ev.stepId} (${ev.kind}): ${ev.error}`;
    case 'step_retrying':
      return `  ↻ step_retrying ${ev.stepId} attempt=${ev.attempt} delay_ms=${ev.nextDelayMs}: ${ev.error}`;
    case 'approval_requested':
      return `  ⏸ approval_requested ${ev.stepId} risk=${ev.risk} approval_id=${ev.approvalId}: ${ev.prompt}`;
    case 'awaiting_event': {
      const match = ev.match ? ` match=${oneLine(ev.match)}` : '';
      return `  ⏳ awaiting_event ${ev.stepId} kind=${ev.eventKind}${match}`;
    }
    case 'workflow_paused':
      return `\n— workflow paused at ${ev.stepId} (reason=${ev.reason})`;
    case 'workflow_resumed':
      return `— workflow resumed${ev.fromStepId !== undefined ? ` from ${ev.fromStepId}` : ''}`;
    case 'workflow_completed':
      return `\n— workflow completed`;
    case 'workflow_failed':
      return `\n— workflow failed${ev.stepId !== undefined ? ` at ${ev.stepId}` : ''}: ${ev.error}`;
    case 'workflow_cancelled':
      return `\n— workflow cancelled`;
    default: {
      const _exhaustive: never = ev;
      void _exhaustive;
      return '';
    }
  }
}

function writeWorkflowEvent(ev: WorkflowEvent, json: boolean): void {
  const line = json ? JSON.stringify(ev) : renderWorkflowEvent(ev);
  process.stdout.write(line + '\n');
}

// ---------------------------------------------------------------------------
// Provider adapter: bridges WorkflowEngine ↔ provider registry.
// ---------------------------------------------------------------------------

/**
 * Adapter that runs a single agent through `getProvider(providerId)` and
 * returns the concatenated assistant messages as the step output. The
 * workflow engine only needs a string-y / JSON-y result; we deliberately
 * keep the surface narrow so swapping providers stays seamless.
 */
export function createProviderAdapter(opts: {
  providerId: ProviderId;
  workspaceRoot: string;
}): ProviderAdapter {
  return {
    async runAgent(input: ProviderAdapterInput): Promise<unknown> {
      const provider = getProvider(opts.providerId);
      const runInput: AgentRunInput = {
        agentId: input.agentId,
        goal: input.goal,
        instructions: '', // engine doesn't carry instructions; provider may load from registry
        workspaceRoot: opts.workspaceRoot,
        signal: input.signal,
        ...(input.model !== undefined ? { model: input.model } : {}),
      };
      const parts: string[] = [];
      let errorMessage: string | null = null;
      let finalReason: 'completed' | 'cancelled' | 'error' = 'error';
      let sawDone = false;

      for await (const ev of provider.run(runInput) as AsyncIterable<RunEvent>) {
        if (ev.type === 'message' && ev.role === 'assistant') {
          parts.push(ev.text);
        } else if (ev.type === 'error') {
          errorMessage = ev.message;
        } else if (ev.type === 'done') {
          sawDone = true;
          finalReason = ev.reason;
        }
      }

      if (!sawDone) {
        throw new Error('provider ended without a done event');
      }
      if (finalReason === 'cancelled') {
        // Surface as throw so the engine treats it as a step failure /
        // cancellation; the outer signal-handler may also set this.
        throw new Error('cancelled');
      }
      if (finalReason === 'error') {
        throw new Error(errorMessage ?? 'provider reported error');
      }
      return parts.join('');
    },
  };
}

// ---------------------------------------------------------------------------
// Step traversal: find the lead agent id (first agent-kind step)
// ---------------------------------------------------------------------------

function findFirstAgentStep(steps: readonly StepDef[]): AgentStepDef | null {
  for (const s of steps) {
    if (s.kind === 'agent') return s;
    if (s.kind === 'sequence') {
      const inner = findFirstAgentStep(s.steps);
      if (inner) return inner;
    } else if (s.kind === 'parallel') {
      for (const branch of s.branches) {
        const inner = findFirstAgentStep(branch);
        if (inner) return inner;
      }
    } else if (s.kind === 'conditional') {
      const inner = findFirstAgentStep(s.then) ?? (s.else ? findFirstAgentStep(s.else) : null);
      if (inner) return inner;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shared DB setup
// ---------------------------------------------------------------------------

async function openWorkspaceDb(workspace: string): Promise<AgentOsDb> {
  const dbPath = defaultDbPath(workspace);
  const db = openDatabase(dbPath);
  try {
    await runMigrations(db, { log: () => undefined });
  } catch (err) {
    db.$sqlite.close();
    throw err;
  }
  return db;
}

/**
 * Ensure an `agents` row exists for `agentId` so the workflow's `runs` row
 * can satisfy the FK. Mirrors the auditor's same-shape upsert in audit.ts.
 */
async function ensureAgentRow(db: AgentOsDb, agentId: string): Promise<void> {
  const existing = await db.select().from(agents).where(eq(agents.id, agentId));
  if (existing.length > 0) return;
  await db.insert(agents).values({
    id: agentId,
    version: '0',
    definitionPath: '',
    hash: '',
    createdAt: new Date(),
  });
}

/**
 * Default approval resolver for the CLI: park the run as paused so the user
 * can resume with `agent-os workflow resume <run-id>` after externally
 * deciding the approval row (e.g. via a future `agent-os approval approve`
 * command). This matches the Phase 5 spec's "paused — resume with …" UX.
 */
const cliApprovalResolver: ApprovalResolver = async () => 'pending';

function resolveProviderId(): ProviderId {
  const config = loadConfig(undefined, { env: process.env });
  const id = config.runtime.default_provider;
  // The config schema validates this already; narrow the type here.
  return id as ProviderId;
}

// ---------------------------------------------------------------------------
// Input parsing: repeatable --input key=value
// ---------------------------------------------------------------------------

function parseInputPairs(pairs: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of pairs) {
    const idx = raw.indexOf('=');
    if (idx === -1) {
      throw new Error(`--input requires key=value form, got "${raw}"`);
    }
    const key = raw.slice(0, idx);
    const value = raw.slice(idx + 1);
    if (key.length === 0) {
      throw new Error(`--input key cannot be empty in "${raw}"`);
    }
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stream consumer with shared exit-code logic.
// ---------------------------------------------------------------------------

interface ConsumeResult {
  exitCode: number;
}

async function consumeEvents(
  stream: AsyncIterable<WorkflowEvent>,
  opts: { json: boolean; runId: string },
): Promise<ConsumeResult> {
  let exitCode = 1;
  let sawTerminal = false;
  for await (const ev of stream) {
    writeWorkflowEvent(ev, opts.json);
    switch (ev.type) {
      case 'workflow_completed':
        sawTerminal = true;
        exitCode = 0;
        break;
      case 'workflow_cancelled':
        sawTerminal = true;
        exitCode = 130;
        break;
      case 'workflow_failed':
        sawTerminal = true;
        exitCode = 1;
        break;
      case 'workflow_paused':
        sawTerminal = true;
        exitCode = 1;
        process.stderr.write(
          `\nworkflow paused — resume with \`agent-os workflow resume ${opts.runId}\`\n`,
        );
        break;
      default:
        break;
    }
  }
  if (!sawTerminal) {
    process.stderr.write('agent-os workflow: stream ended without a terminal event\n');
    exitCode = 1;
  }
  return { exitCode };
}

// ---------------------------------------------------------------------------
// `workflow run <workflow-id>`
// ---------------------------------------------------------------------------

interface RunCliOptions {
  json?: boolean;
  input?: string[];
}

/** Hooks for tests — keeps the SQLite + provider plumbing injectable. */
export interface WorkflowRunInternals {
  /** Override the engine adapter (used by tests to inject a fake). */
  providerAdapterFactory?: (opts: {
    providerId: ProviderId;
    workspaceRoot: string;
  }) => ProviderAdapter;
}

export async function runWorkflowCommand(
  cwd: string,
  workflowId: string,
  options: RunCliOptions,
  internals: WorkflowRunInternals = {},
): Promise<number> {
  const workspace = resolveWorkspaceRoot(cwd);
  const defs = await loadAllWorkflows(workspace);
  const found = defs.find((d) => d.def.id === workflowId);
  if (!found) {
    process.stderr.write(`agent-os workflow: workflow "${workflowId}" not found\n`);
    return 1;
  }
  const def = found.def;

  const leadStep = findFirstAgentStep(def.steps);
  if (!leadStep) {
    process.stderr.write(
      `agent-os workflow: workflow "${workflowId}" has no agent step; cannot derive lead agent\n`,
    );
    return 1;
  }
  const leadAgentId = leadStep.agent;

  let input: Record<string, string>;
  try {
    input = parseInputPairs(options.input ?? []);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`agent-os workflow run: ${message}\n`);
    return 1;
  }

  const providerId = resolveProviderId();
  if (!hasProvider(providerId)) {
    const config = loadConfig(undefined, { env: process.env });
    await ensureBuiltinProvidersRegistered(config as unknown as Record<string, unknown>);
  }

  const runId = randomUUID();
  const json = options.json === true;
  process.stdout.write(`run_id: ${runId}\n`);

  const controller = new AbortController();
  const onSigint = (): void => {
    controller.abort();
  };
  process.on('SIGINT', onSigint);

  const db = await openWorkspaceDb(workspace);
  const blobs = createBlobStore({ root: join(workspace, '.agent-os', 'blobs') });
  await ensureAgentRow(db, leadAgentId);

  const adapterFactory = internals.providerAdapterFactory ?? createProviderAdapter;
  const adapter = adapterFactory({ providerId, workspaceRoot: workspace });

  let exitCode = 1;
  try {
    const stream = runWorkflow({
      def,
      runId,
      agentId: leadAgentId,
      input,
      provider: providerId,
      model: def.id,
      db,
      blobs,
      providerAdapter: adapter,
      approvalResolver: cliApprovalResolver,
      signal: controller.signal,
    });
    const result = await consumeEvents(stream, { json, runId });
    exitCode = result.exitCode;
    if (controller.signal.aborted) {
      // Best-effort: persist cancelled status if the engine has not already.
      try {
        await cancelWorkflow({ runId, db, reason: 'SIGINT' });
      } catch {
        // Ignore — the run may already be terminal.
      }
      exitCode = 130;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`agent-os workflow run: ${message}\n`);
    exitCode = 1;
  } finally {
    process.off('SIGINT', onSigint);
    db.$sqlite.close();
  }
  return exitCode;
}

// ---------------------------------------------------------------------------
// `workflow resume <run-id>`
// ---------------------------------------------------------------------------

interface ResumeCliOptions {
  json?: boolean;
}

export async function resumeWorkflowCommand(
  cwd: string,
  runId: string,
  options: ResumeCliOptions,
  internals: WorkflowRunInternals = {},
): Promise<number> {
  const workspace = resolveWorkspaceRoot(cwd);
  const db = await openWorkspaceDb(workspace);
  const blobs = createBlobStore({ root: join(workspace, '.agent-os', 'blobs') });

  const json = options.json === true;
  const controller = new AbortController();
  const onSigint = (): void => {
    controller.abort();
  };
  process.on('SIGINT', onSigint);

  let exitCode = 1;
  try {
    const rows = await db.select().from(runs).where(eq(runs.id, runId));
    if (rows.length === 0) {
      process.stderr.write(`agent-os workflow resume: run "${runId}" not found\n`);
      return 1;
    }
    const row = rows[0]!;
    if (!row.workflowId) {
      process.stderr.write(
        `agent-os workflow resume: run "${runId}" has no workflow_id; cannot resume\n`,
      );
      return 1;
    }

    const defs = await loadAllWorkflows(workspace);
    const found = defs.find((d) => d.def.id === row.workflowId);
    if (!found) {
      process.stderr.write(
        `agent-os workflow resume: workflow "${row.workflowId}" not found in ${workflowsDir(workspace)}\n`,
      );
      return 1;
    }

    const providerId = resolveProviderId();
    if (!hasProvider(providerId)) {
      const config = loadConfig(undefined, { env: process.env });
      await ensureBuiltinProvidersRegistered(config as unknown as Record<string, unknown>);
    }
    const adapterFactory = internals.providerAdapterFactory ?? createProviderAdapter;
    const adapter = adapterFactory({ providerId, workspaceRoot: workspace });

    const stream = resumeWorkflow({
      def: found.def,
      runId,
      db,
      blobs,
      providerAdapter: adapter,
      approvalResolver: cliApprovalResolver,
      signal: controller.signal,
    });
    const result = await consumeEvents(stream, { json, runId });
    exitCode = result.exitCode;
    if (controller.signal.aborted) {
      try {
        await cancelWorkflow({ runId, db, reason: 'SIGINT' });
      } catch {
        // Ignore.
      }
      exitCode = 130;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`agent-os workflow resume: ${message}\n`);
    exitCode = 1;
  } finally {
    process.off('SIGINT', onSigint);
    db.$sqlite.close();
  }
  return exitCode;
}

// ---------------------------------------------------------------------------
// `workflow cancel <run-id>`
// ---------------------------------------------------------------------------

export async function cancelWorkflowCommand(cwd: string, runId: string): Promise<number> {
  const workspace = resolveWorkspaceRoot(cwd);
  const db = await openWorkspaceDb(workspace);
  try {
    const rows = await db.select().from(runs).where(eq(runs.id, runId));
    if (rows.length === 0) {
      process.stderr.write(`agent-os workflow cancel: run "${runId}" not found\n`);
      return 1;
    }
    await cancelWorkflow({ runId, db, reason: 'cancelled via CLI' });
    process.stdout.write(`cancelled: ${runId}\n`);
    return 0;
  } finally {
    db.$sqlite.close();
  }
}

// ---------------------------------------------------------------------------
// `workflow show <run-id>`
// ---------------------------------------------------------------------------

interface ShowCliOptions {
  json?: boolean;
}

interface ShowStepRow {
  id: string;
  kind: string;
  name: string;
  status: string;
  started_at: number | null;
  ended_at: number | null;
  duration_ms: number | null;
  error: string | null;
}

interface ShowApprovalRow {
  id: string;
  step_id: string | null;
  status: string;
  action: string;
}

interface ShowPayload {
  run: {
    id: string;
    workflow_id: string | null;
    agent_id: string;
    status: string;
    started_at: number | null;
    ended_at: number | null;
    duration_ms: number | null;
    provider: string;
    model: string;
    summary: string | null;
  };
  steps: ShowStepRow[];
  pending_approvals: ShowApprovalRow[];
}

function toEpochMs(value: Date | null | undefined): number | null {
  if (value == null) return null;
  // Drizzle returns native Date for timestamp columns.
  if (value instanceof Date) return value.getTime();
  // Some drivers surface a number; coerce defensively.
  return Number(value);
}

export async function showWorkflowCommand(
  cwd: string,
  runId: string,
  opts: ShowCliOptions,
): Promise<number> {
  const workspace = resolveWorkspaceRoot(cwd);
  const db = await openWorkspaceDb(workspace);
  try {
    const runRows = await db.select().from(runs).where(eq(runs.id, runId));
    if (runRows.length === 0) {
      process.stderr.write(`agent-os workflow show: run "${runId}" not found\n`);
      return 1;
    }
    const r = runRows[0]!;
    const started = toEpochMs(r.startedAt);
    const ended = toEpochMs(r.endedAt);
    const duration = started !== null && ended !== null ? ended - started : null;

    const stepRows = await db.select().from(steps).where(eq(steps.runId, runId));
    const stepsOut: ShowStepRow[] = stepRows
      .map((s) => {
        const sStarted = toEpochMs(s.startedAt);
        const sEnded = toEpochMs(s.endedAt);
        return {
          id: s.id,
          kind: s.kind,
          name: s.name,
          status: s.status,
          started_at: sStarted,
          ended_at: sEnded,
          duration_ms: sStarted !== null && sEnded !== null ? sEnded - sStarted : null,
          error: s.error,
        };
      })
      .sort((a, b) => (a.started_at ?? 0) - (b.started_at ?? 0));

    const pendingApprovals = await db
      .select()
      .from(approvals)
      .where(and(eq(approvals.runId, runId), eq(approvals.status, 'pending')));
    const approvalsOut: ShowApprovalRow[] = pendingApprovals.map((a) => ({
      id: a.id,
      step_id: a.stepId,
      status: a.status,
      action: a.action,
    }));

    const payload: ShowPayload = {
      run: {
        id: r.id,
        workflow_id: r.workflowId,
        agent_id: r.agentId,
        status: r.status,
        started_at: started,
        ended_at: ended,
        duration_ms: duration,
        provider: r.provider,
        model: r.model,
        summary: r.summary,
      },
      steps: stepsOut,
      pending_approvals: approvalsOut,
    };

    if (opts.json) {
      process.stdout.write(JSON.stringify(payload) + '\n');
      return 0;
    }

    const lines: string[] = [];
    lines.push(`run: ${payload.run.id}`);
    lines.push(`workflow_id: ${payload.run.workflow_id ?? '(none)'}`);
    lines.push(`agent_id: ${payload.run.agent_id}`);
    lines.push(`status: ${payload.run.status}`);
    lines.push(`provider: ${payload.run.provider}`);
    lines.push(`model: ${payload.run.model}`);
    lines.push(
      `started_at: ${payload.run.started_at !== null ? new Date(payload.run.started_at).toISOString() : '—'}`,
    );
    lines.push(
      `ended_at: ${payload.run.ended_at !== null ? new Date(payload.run.ended_at).toISOString() : '—'}`,
    );
    lines.push(`duration_ms: ${payload.run.duration_ms ?? '—'}`);
    if (payload.run.summary) lines.push(`summary: ${payload.run.summary}`);

    lines.push('');
    if (stepsOut.length === 0) {
      lines.push('steps: (none)');
    } else {
      lines.push('steps:');
      const rows = stepsOut.map((s) => [
        s.id,
        s.kind,
        s.name,
        s.status,
        s.duration_ms === null ? '—' : `${s.duration_ms}ms`,
        s.error ?? '',
      ]);
      lines.push(
        formatTable(['ID', 'KIND', 'NAME', 'STATUS', 'DURATION', 'ERROR'], rows).trimEnd(),
      );
    }

    lines.push('');
    if (approvalsOut.length === 0) {
      lines.push('pending_approvals: (none)');
    } else {
      lines.push('pending_approvals:');
      const rows = approvalsOut.map((a) => [a.id, a.step_id ?? '', a.action]);
      lines.push(formatTable(['ID', 'STEP_ID', 'ACTION'], rows).trimEnd());
    }
    process.stdout.write(lines.join('\n') + '\n');
    return 0;
  } finally {
    db.$sqlite.close();
  }
}

// ---------------------------------------------------------------------------
// Command wiring
// ---------------------------------------------------------------------------

function withErrorReporting(fn: () => Promise<void>, label: string): () => Promise<void> {
  return async () => {
    try {
      await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`agent-os ${label}: ${message}\n`);
      process.exit(1);
    }
  };
}

export function buildWorkflowCommand(): Command {
  const cmd = new Command('workflow').description('Inspect, run, and resume workflow definitions');

  cmd
    .command('list')
    .description('List all workflows in the workspace')
    .option('--json', 'Emit a machine-readable JSON array', false)
    .action((options: ListCliOptions) =>
      withErrorReporting(() => runList(process.cwd(), options), 'workflow list')(),
    );

  cmd
    .command('run <workflow-id>')
    .description('Run a workflow end-to-end and stream events to stdout')
    .option('--json', 'Emit one WorkflowEvent per line as JSONL', false)
    .option(
      '--input <key=value>',
      'Workflow input (repeatable; e.g. --input name=foo)',
      (value: string, prev: string[] = []) => prev.concat(value),
      [] as string[],
    )
    .action(async (workflowId: string, options: RunCliOptions) => {
      let code: number;
      try {
        code = await runWorkflowCommand(process.cwd(), workflowId, options);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`agent-os workflow run: ${message}\n`);
        code = 1;
      }
      if (code !== 0) {
        process.exit(code);
      }
    });

  cmd
    .command('resume <run-id>')
    .description('Resume a paused workflow run')
    .option('--json', 'Emit one WorkflowEvent per line as JSONL', false)
    .action(async (runId: string, options: ResumeCliOptions) => {
      let code: number;
      try {
        code = await resumeWorkflowCommand(process.cwd(), runId, options);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`agent-os workflow resume: ${message}\n`);
        code = 1;
      }
      if (code !== 0) {
        process.exit(code);
      }
    });

  cmd
    .command('cancel <run-id>')
    .description('Cancel an in-flight or paused workflow run')
    .action(async (runId: string) => {
      let code: number;
      try {
        code = await cancelWorkflowCommand(process.cwd(), runId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`agent-os workflow cancel: ${message}\n`);
        code = 1;
      }
      if (code !== 0) {
        process.exit(code);
      }
    });

  cmd
    .command('show <run-id>')
    .description('Show the rows for a workflow run and its steps')
    .option('--json', 'Emit a machine-readable JSON payload', false)
    .action(async (runId: string, options: ShowCliOptions) => {
      let code: number;
      try {
        code = await showWorkflowCommand(process.cwd(), runId, options);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`agent-os workflow show: ${message}\n`);
        code = 1;
      }
      if (code !== 0) {
        process.exit(code);
      }
    });

  return cmd;
}
