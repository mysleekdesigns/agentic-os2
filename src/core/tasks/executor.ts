/**
 * Durable workflow executor (PRD §3 Phase 5).
 *
 * Persistence model
 * -----------------
 * - One row in `runs` per workflow run (`runs.workflow_id = def.id`).
 * - One row in `steps` per executed step, keyed by `${runId}:${scopedStepId}`
 *   so retries are idempotent.
 * - Step inputs/outputs are stored in the blob store; the digests are written
 *   to `steps.input_ref` / `steps.output_ref`.
 * - Approvals are inserted into the `approvals` table.
 * - `wait_event` steps look up the `events` table for a matching row whose
 *   `created_at >= step.started_at`.
 *
 * Resume strategy
 * ---------------
 * When the workflow is paused (approval or wait_event), we mark the run as
 * `status='pending'` and leave the corresponding step in `status='running'`
 * — the step row plus the pending approval / awaited event together encode
 * the wait.
 *
 * Awaiting-approval representation (Phase 6)
 * ------------------------------------------
 * There is NO new run status. A run is "awaiting_approval" iff:
 *   `runs.status = 'pending'`
 *   AND ∃ an `approvals` row with `run_id = runs.id AND status = 'pending'`.
 *
 * Approval rows are written via the queue API in `src/core/approvals/` so
 * every transition (request, approve, reject, revise, expire) emits an
 * `events` row — that's the audit trail. The executor itself does NOT poll
 * for a decision: when it encounters a still-pending approval it emits
 * `workflow_paused` and exits the async iterator. `resumeWorkflow` is the
 * caller's responsibility — typically invoked from the approvals CLI after
 * `decideRequest` flips the row.
 *
 * `resumeWorkflow` reloads the state from the DB:
 *   1. Walks completed steps into `WorkflowRunState.completedStepIds` and
 *      rehydrates their outputs from blobs.
 *   2. Finds the first not-completed step in DAG order.
 *   3. If that step is `pending` (waiting), check whether the wait has
 *      resolved (approval decided, event arrived) and pick up from there.
 *   4. If the step is `succeeded`, skip (idempotency by step id).
 *   5. Otherwise execute it fresh.
 *
 * Cancellation is cooperative: callers pass an `AbortSignal`, and the
 * executor checks `signal.aborted` between steps.
 *
 * The executor does NOT import provider SDKs; instead it takes a
 * `ProviderAdapter` interface so tests can fake it without any env vars.
 */

import { and, eq, gte } from 'drizzle-orm';

import type { AgentOsDb } from '../../storage/db.js';
import type { BlobStore } from '../../storage/blobs.js';
import { approvals as schemaApprovals, events, runs, steps } from '../../storage/schema.js';
import {
  createRequest as createApprovalRequest,
  decideRequest as decideApprovalRequest,
  getRequest as getApprovalRequest,
} from '../approvals/index.js';
import type {
  AgentStepDef,
  ApprovalStepDef,
  ConditionalStepDef,
  ParallelStepDef,
  PauseReason,
  RetryPolicy,
  SequenceStepDef,
  StepDef,
  WaitEventStepDef,
  WorkflowDef,
  WorkflowEvent,
  WorkflowRunState,
} from './types.js';

// ---------------------------------------------------------------------------
// Provider adapter — the executor's only seam into model execution.
// ---------------------------------------------------------------------------

export interface ProviderAdapterInput {
  agentId: string;
  goal: string;
  model?: string;
  timeoutMs?: number;
  signal: AbortSignal;
  runId: string;
  stepId: string;
}

export interface ProviderAdapter {
  /**
   * Run a single agent and return its final textual output. Implementations
   * are responsible for honouring the provided `AbortSignal` and surfacing
   * provider-side failures as thrown errors.
   */
  runAgent(input: ProviderAdapterInput): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Public API surface for this module.
// ---------------------------------------------------------------------------

/** Resolver invoked when the executor blocks on an `approval` step. */
export interface ApprovalResolverInput {
  runId: string;
  approvalId: string;
  stepId: string;
  prompt: string;
  risk: ApprovalStepDef['risk'];
}

export type ApprovalResolver = (
  input: ApprovalResolverInput,
) => Promise<'approve' | 'reject' | 'pending'>;

export interface RunWorkflowOptions {
  def: WorkflowDef;
  /**
   * Stable run id. Re-invoking with the same id reuses the existing rows and
   * resumes from the last completed step.
   */
  runId: string;
  /**
   * Lead/orchestrator agent id stored on `runs.agent_id`. Must reference a
   * row in `agents`. If you don't have a lead agent, set it to a sentinel
   * such as `'__workflow__'` that you've also inserted into the registry.
   */
  agentId: string;
  /** Free-form input payload — interpolated into goal templates. */
  input?: Record<string, unknown>;
  /** Provider/model recorded on the `runs` row (NOT used for execution). */
  provider?: string;
  model?: string;
  db: AgentOsDb;
  blobs: BlobStore;
  providerAdapter: ProviderAdapter;
  /** Defaults to auto-reject (causes the workflow to fail at the approval). */
  approvalResolver?: ApprovalResolver;
  /** Cooperative cancellation. */
  signal?: AbortSignal;
}

export interface ResumeWorkflowOptions {
  def: WorkflowDef;
  runId: string;
  db: AgentOsDb;
  blobs: BlobStore;
  providerAdapter: ProviderAdapter;
  approvalResolver?: ApprovalResolver;
  signal?: AbortSignal;
}

export interface CancelWorkflowOptions {
  runId: string;
  db: AgentOsDb;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class StepFailure extends Error {
  constructor(
    message: string,
    public readonly stepId: string,
  ) {
    super(message);
    this.name = 'StepFailure';
  }
}

class WorkflowPause extends Error {
  constructor(
    public readonly reason: PauseReason,
    public readonly stepId: string,
  ) {
    super(`workflow paused at ${stepId} (${reason})`);
    this.name = 'WorkflowPause';
  }
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Start (or resume) a workflow run. Returns an `AsyncIterable<WorkflowEvent>`
 * that the caller can consume to observe progress in real time.
 */
export function runWorkflow(opts: RunWorkflowOptions): AsyncIterable<WorkflowEvent> {
  return executeStream(opts, /* isResume */ false);
}

/** Resume a paused workflow run. Same shape as `runWorkflow`. */
export function resumeWorkflow(opts: ResumeWorkflowOptions): AsyncIterable<WorkflowEvent> {
  // The resume path reuses `runWorkflow`; we only need to pull the
  // pre-existing `runs` row to preserve `agentId`/`provider`/`model`.
  return executeStream(
    {
      def: opts.def,
      runId: opts.runId,
      agentId: '', // populated from DB inside `executeStream`
      db: opts.db,
      blobs: opts.blobs,
      providerAdapter: opts.providerAdapter,
      ...(opts.approvalResolver ? { approvalResolver: opts.approvalResolver } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    },
    true,
  );
}

/** Mark a workflow run as cancelled. Idempotent. */
export async function cancelWorkflow(opts: CancelWorkflowOptions): Promise<void> {
  const existing = await opts.db.select().from(runs).where(eq(runs.id, opts.runId));
  if (existing.length === 0) return;
  const row = existing[0]!;
  if (row.status === 'cancelled' || row.status === 'succeeded' || row.status === 'failed') {
    return;
  }
  await opts.db
    .update(runs)
    .set({ status: 'cancelled', endedAt: new Date(), summary: opts.reason ?? row.summary })
    .where(eq(runs.id, opts.runId));
}

// ---------------------------------------------------------------------------
// Internal executor
// ---------------------------------------------------------------------------

interface ExecutorCtx {
  runId: string;
  def: WorkflowDef;
  state: WorkflowRunState;
  db: AgentOsDb;
  blobs: BlobStore;
  providerAdapter: ProviderAdapter;
  approvalResolver: ApprovalResolver;
  signal: AbortSignal;
  emit: (ev: WorkflowEvent) => void;
}

async function* executeStream(
  opts: RunWorkflowOptions,
  isResume: boolean,
): AsyncGenerator<WorkflowEvent, void, void> {
  // Event queue bridges synchronous emits inside step handlers to the async
  // iterator that the caller drives.
  const queue: WorkflowEvent[] = [];
  const waiterRef: { fn: (() => void) | null } = { fn: null };
  let done = false;
  let finalError: Error | null = null;

  const emit = (ev: WorkflowEvent): void => {
    queue.push(ev);
    if (waiterRef.fn) {
      const w = waiterRef.fn;
      waiterRef.fn = null;
      w();
    }
  };

  // Drive the actual execution in a background promise; the caller observes
  // progress through the queue.
  const runner = (async () => {
    try {
      await execute(opts, isResume, emit);
    } catch (err) {
      finalError = err instanceof Error ? err : new Error(String(err));
    } finally {
      done = true;
      if (waiterRef.fn) {
        const w = waiterRef.fn;
        waiterRef.fn = null;
        w();
      }
    }
  })();

  try {
    while (true) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      if (done) break;
      await new Promise<void>((resolve) => {
        waiterRef.fn = resolve;
      });
    }
    await runner;
    if (finalError) throw finalError;
  } finally {
    // Drain any pending events even on early return so the queue isn't held.
    queue.length = 0;
  }
}

async function execute(
  opts: RunWorkflowOptions,
  isResume: boolean,
  emit: (ev: WorkflowEvent) => void,
): Promise<void> {
  const { def, runId, db, blobs, providerAdapter } = opts;
  const signal = opts.signal ?? new AbortController().signal;
  const approvalResolver: ApprovalResolver = opts.approvalResolver ?? (async () => 'reject');

  // Rehydrate or insert the runs row.
  const existing = await db.select().from(runs).where(eq(runs.id, runId));
  let resolvedAgentId = opts.agentId;
  let runIsFresh = false;

  if (existing.length === 0) {
    if (isResume) {
      throw new Error(`cannot resume: run "${runId}" does not exist`);
    }
    if (!resolvedAgentId) {
      throw new Error('agentId is required for a fresh runWorkflow call');
    }
    await db.insert(runs).values({
      id: runId,
      agentId: resolvedAgentId,
      workflowId: def.id,
      status: 'running',
      startedAt: new Date(),
      provider: opts.provider ?? 'workflow',
      model: opts.model ?? def.id,
    });
    runIsFresh = true;
  } else {
    const row = existing[0]!;
    resolvedAgentId = row.agentId;
    if (row.status === 'succeeded' || row.status === 'failed' || row.status === 'cancelled') {
      // Terminal — nothing to do. Emit a tail event for the consumer.
      const now = Date.now();
      if (row.status === 'cancelled') {
        emit({ type: 'workflow_cancelled', runId, timestamp: now });
      } else if (row.status === 'failed') {
        emit({ type: 'workflow_failed', runId, timestamp: now, error: row.summary ?? 'failed' });
      } else {
        emit({ type: 'workflow_completed', runId, timestamp: now });
      }
      return;
    }
    // Move 'pending' (paused) → 'running' as we resume.
    await db.update(runs).set({ status: 'running' }).where(eq(runs.id, runId));
  }

  // Rebuild state from existing step rows.
  const state = await rehydrateState(db, blobs, runId, def);

  if (!runIsFresh) {
    emit({
      type: 'workflow_resumed',
      runId,
      timestamp: Date.now(),
      ...(state.currentStepId ? { fromStepId: state.currentStepId } : {}),
    });
  }

  // Merge any caller-supplied input into the state so goal templating works.
  const ctx: ExecutorCtx = {
    runId,
    def,
    state,
    db,
    blobs,
    providerAdapter,
    approvalResolver,
    signal,
    emit,
  };

  // Stash inputs on the state outputs under the reserved key `__inputs__` so
  // interpolation has a consistent lookup mechanism.
  if (opts.input) {
    state.outputs.set('__inputs__', opts.input);
  }

  try {
    await executeSteps(def.steps, ctx);
    await db
      .update(runs)
      .set({ status: 'succeeded', endedAt: new Date() })
      .where(eq(runs.id, runId));
    emit({ type: 'workflow_completed', runId, timestamp: Date.now() });
  } catch (err) {
    if (err instanceof WorkflowPause) {
      // Run row already updated to 'pending' inside the step handler.
      emit({
        type: 'workflow_paused',
        runId,
        timestamp: Date.now(),
        reason: err.reason,
        stepId: err.stepId,
      });
      return;
    }
    if (signal.aborted) {
      await db
        .update(runs)
        .set({ status: 'cancelled', endedAt: new Date() })
        .where(eq(runs.id, runId));
      emit({ type: 'workflow_cancelled', runId, timestamp: Date.now() });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    const failedStepId = err instanceof StepFailure ? err.stepId : undefined;
    await db
      .update(runs)
      .set({ status: 'failed', endedAt: new Date(), summary: message })
      .where(eq(runs.id, runId));
    emit({
      type: 'workflow_failed',
      runId,
      timestamp: Date.now(),
      error: message,
      ...(failedStepId ? { stepId: failedStepId } : {}),
    });
  }
}

// ---------------------------------------------------------------------------
// Step dispatch
// ---------------------------------------------------------------------------

async function executeSteps(stepList: StepDef[], ctx: ExecutorCtx): Promise<void> {
  for (const step of stepList) {
    if (ctx.signal.aborted) {
      throw new Error('cancelled');
    }
    await executeStep(step, ctx);
  }
}

async function executeStep(step: StepDef, ctx: ExecutorCtx): Promise<void> {
  // Idempotency: skip if already succeeded.
  if (ctx.state.completedStepIds.has(step.id)) {
    return;
  }
  ctx.state.currentStepId = step.id;
  switch (step.kind) {
    case 'agent':
      await executeAgentStep(step, ctx);
      return;
    case 'parallel':
      await executeParallelStep(step, ctx);
      return;
    case 'conditional':
      await executeConditionalStep(step, ctx);
      return;
    case 'approval':
      await executeApprovalStep(step, ctx);
      return;
    case 'wait_event':
      await executeWaitEventStep(step, ctx);
      return;
    case 'sequence':
      await executeSequenceStep(step, ctx);
      return;
    default: {
      const _exhaustive: never = step;
      throw new Error(`unknown step kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Step handlers
// ---------------------------------------------------------------------------

async function executeAgentStep(step: AgentStepDef, ctx: ExecutorCtx): Promise<void> {
  const dbStepId = scopedStepId(ctx.runId, step.id);
  const goal = interpolate(step.goal, ctx.state);
  const inputRef = await ctx.blobs.write(JSON.stringify({ agent: step.agent, goal }));

  await upsertStepRunning(ctx, step.id, 'workflow_step', step.kind, inputRef);
  ctx.emit({
    type: 'step_started',
    runId: ctx.runId,
    timestamp: Date.now(),
    stepId: step.id,
    kind: 'agent',
  });

  const retry: RetryPolicy = step.retry ?? { max_attempts: 1, backoff_ms: 0 };
  let attempt = 0;
  let lastErr: Error | null = null;

  while (attempt < retry.max_attempts) {
    if (ctx.signal.aborted) throw new Error('cancelled');
    attempt++;

    const timeoutCtl = new AbortController();
    const timer =
      step.timeout_ms !== undefined
        ? setTimeout(() => timeoutCtl.abort(new Error('step timeout')), step.timeout_ms)
        : null;
    const combined = combineSignals(ctx.signal, timeoutCtl.signal);

    try {
      const output = await ctx.providerAdapter.runAgent({
        agentId: step.agent,
        goal,
        ...(step.model !== undefined ? { model: step.model } : {}),
        ...(step.timeout_ms !== undefined ? { timeoutMs: step.timeout_ms } : {}),
        signal: combined,
        runId: ctx.runId,
        stepId: step.id,
      });
      if (timer) clearTimeout(timer);

      const outputRef = await ctx.blobs.write(JSON.stringify({ output }));
      await markStepSucceeded(ctx, dbStepId, outputRef);
      ctx.state.completedStepIds.add(step.id);
      ctx.state.outputs.set(step.id, output);
      ctx.emit({
        type: 'step_completed',
        runId: ctx.runId,
        timestamp: Date.now(),
        stepId: step.id,
        kind: 'agent',
        output,
      });
      return;
    } catch (err) {
      if (timer) clearTimeout(timer);
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt < retry.max_attempts) {
        const multiplier = retry.multiplier ?? 1;
        const delay = retry.backoff_ms * Math.pow(multiplier, attempt - 1);
        ctx.emit({
          type: 'step_retrying',
          runId: ctx.runId,
          timestamp: Date.now(),
          stepId: step.id,
          attempt,
          nextDelayMs: delay,
          error: lastErr.message,
        });
        if (delay > 0) {
          await sleep(delay, ctx.signal);
        }
        continue;
      }
    }
  }

  // Retries exhausted.
  await markStepFailed(ctx, dbStepId, lastErr?.message ?? 'unknown error');
  ctx.emit({
    type: 'step_failed',
    runId: ctx.runId,
    timestamp: Date.now(),
    stepId: step.id,
    kind: 'agent',
    error: lastErr?.message ?? 'unknown error',
  });
  throw new StepFailure(lastErr?.message ?? 'step failed', step.id);
}

async function executeParallelStep(step: ParallelStepDef, ctx: ExecutorCtx): Promise<void> {
  const dbStepId = scopedStepId(ctx.runId, step.id);
  await upsertStepRunning(ctx, step.id, 'workflow_step', step.kind, null);
  ctx.emit({
    type: 'step_started',
    runId: ctx.runId,
    timestamp: Date.now(),
    stepId: step.id,
    kind: 'parallel',
  });

  try {
    await Promise.all(step.branches.map((branch) => executeSteps(branch, ctx)));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markStepFailed(ctx, dbStepId, message);
    ctx.emit({
      type: 'step_failed',
      runId: ctx.runId,
      timestamp: Date.now(),
      stepId: step.id,
      kind: 'parallel',
      error: message,
    });
    throw err;
  }

  await markStepSucceeded(ctx, dbStepId, null);
  ctx.state.completedStepIds.add(step.id);
  ctx.emit({
    type: 'step_completed',
    runId: ctx.runId,
    timestamp: Date.now(),
    stepId: step.id,
    kind: 'parallel',
  });
}

async function executeConditionalStep(step: ConditionalStepDef, ctx: ExecutorCtx): Promise<void> {
  const dbStepId = scopedStepId(ctx.runId, step.id);
  await upsertStepRunning(ctx, step.id, 'workflow_step', step.kind, null);
  ctx.emit({
    type: 'step_started',
    runId: ctx.runId,
    timestamp: Date.now(),
    stepId: step.id,
    kind: 'conditional',
  });

  let taken: 'then' | 'else';
  try {
    const truthy = evaluateExpression(step.when, ctx.state);
    taken = truthy ? 'then' : 'else';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markStepFailed(ctx, dbStepId, `expression error: ${message}`);
    ctx.emit({
      type: 'step_failed',
      runId: ctx.runId,
      timestamp: Date.now(),
      stepId: step.id,
      kind: 'conditional',
      error: message,
    });
    throw new StepFailure(message, step.id);
  }

  const branchSteps = taken === 'then' ? step.then : (step.else ?? []);
  await executeSteps(branchSteps, ctx);

  await markStepSucceeded(ctx, dbStepId, null);
  ctx.state.completedStepIds.add(step.id);
  ctx.state.outputs.set(step.id, { taken });
  ctx.emit({
    type: 'step_completed',
    runId: ctx.runId,
    timestamp: Date.now(),
    stepId: step.id,
    kind: 'conditional',
    output: { taken },
  });
}

async function executeApprovalStep(step: ApprovalStepDef, ctx: ExecutorCtx): Promise<void> {
  const dbStepId = scopedStepId(ctx.runId, step.id);

  // Find an existing approval row (resume case). We query the `approvals`
  // table directly here because the queue API exposes per-id lookup, not
  // per-step. Once we have the id we round-trip through `getApprovalRequest`
  // so any future changes to the row shape stay encapsulated.
  const existingApprovalIds = await ctx.db
    .select({ id: schemaApprovals.id })
    .from(schemaApprovals)
    .where(eq(schemaApprovals.stepId, dbStepId));

  let approvalId: string;

  if (existingApprovalIds.length === 0) {
    // Fresh approval — persist via the queue so an `approval.requested`
    // event is appended to the audit trail.
    await upsertStepRunning(ctx, step.id, 'approval', step.kind, null);
    const created = await createApprovalRequest({
      db: ctx.db,
      runId: ctx.runId,
      stepId: dbStepId,
      requestedBy: 'workflow',
      action: step.prompt,
      reason: `risk=${step.risk}`,
      // TTL: workflow definitions do not (yet) carry explicit TTLs at this
      // layer. The queue policies module owns TTL resolution; the executor
      // passes `undefined` so `defaultTtlSeconds` (when provided) wins, or
      // the queue stores `expires_at=null` (never expires) otherwise.
    });
    approvalId = created.id;
    ctx.emit({
      type: 'step_started',
      runId: ctx.runId,
      timestamp: Date.now(),
      stepId: step.id,
      kind: 'approval',
    });
  } else {
    approvalId = existingApprovalIds[0]!.id;
    const existing = await getApprovalRequest(approvalId, { db: ctx.db });

    // Decision already in — fast-path on resume.
    if (existing && existing.status === 'approved') {
      await markStepSucceeded(ctx, dbStepId, null);
      ctx.state.completedStepIds.add(step.id);
      ctx.state.outputs.set(step.id, { approved: true });
      ctx.emit({
        type: 'step_completed',
        runId: ctx.runId,
        timestamp: Date.now(),
        stepId: step.id,
        kind: 'approval',
        output: { approved: true },
      });
      return;
    }
    if (existing && (existing.status === 'rejected' || existing.status === 'expired')) {
      const reason =
        existing.status === 'expired'
          ? 'approval expired'
          : (existing.note ?? existing.reason ?? 'approval rejected');
      await markStepFailed(ctx, dbStepId, reason);
      ctx.emit({
        type: 'step_failed',
        runId: ctx.runId,
        timestamp: Date.now(),
        stepId: step.id,
        kind: 'approval',
        error: reason,
      });
      throw new StepFailure(reason, step.id);
    }
  }

  ctx.emit({
    type: 'approval_requested',
    runId: ctx.runId,
    timestamp: Date.now(),
    stepId: step.id,
    approvalId,
    prompt: step.prompt,
    risk: step.risk,
  });

  const verdict = await ctx.approvalResolver({
    runId: ctx.runId,
    approvalId,
    stepId: step.id,
    prompt: step.prompt,
    risk: step.risk,
  });

  if (verdict === 'pending') {
    // Park the run and exit. The executor does NOT poll — the CLI / event
    // bus will call `resumeWorkflow` after a decision flips the row.
    await ctx.db.update(runs).set({ status: 'pending' }).where(eq(runs.id, ctx.runId));
    throw new WorkflowPause('approval', step.id);
  }

  if (verdict === 'approve') {
    // Route through `decideApprovalRequest` so the audit log gets an
    // `approval.approved` event. We only do this when the row is still
    // pending — on resume after an out-of-band update, the fast-path above
    // returns first.
    const current = await getApprovalRequest(approvalId, { db: ctx.db });
    if (current && current.status === 'pending') {
      await decideApprovalRequest({
        db: ctx.db,
        approvalId,
        verdict: 'approve',
        decidedBy: 'resolver',
      });
    }
    await markStepSucceeded(ctx, dbStepId, null);
    ctx.state.completedStepIds.add(step.id);
    ctx.state.outputs.set(step.id, { approved: true });
    ctx.emit({
      type: 'step_completed',
      runId: ctx.runId,
      timestamp: Date.now(),
      stepId: step.id,
      kind: 'approval',
      output: { approved: true },
    });
    return;
  }

  // verdict === 'reject'
  const reason = 'approval rejected by resolver';
  const current = await getApprovalRequest(approvalId, { db: ctx.db });
  if (current && current.status === 'pending') {
    await decideApprovalRequest({
      db: ctx.db,
      approvalId,
      verdict: 'reject',
      decidedBy: 'resolver',
      note: reason,
    });
  }
  await markStepFailed(ctx, dbStepId, reason);
  ctx.emit({
    type: 'step_failed',
    runId: ctx.runId,
    timestamp: Date.now(),
    stepId: step.id,
    kind: 'approval',
    error: reason,
  });
  throw new StepFailure(reason, step.id);
}

async function executeWaitEventStep(step: WaitEventStepDef, ctx: ExecutorCtx): Promise<void> {
  const dbStepId = scopedStepId(ctx.runId, step.id);

  // Determine the window start. Reuse the existing step's started_at if we're
  // resuming, otherwise insert a fresh row.
  let startedAt: Date;
  const existingSteps = await ctx.db.select().from(steps).where(eq(steps.id, dbStepId));
  if (existingSteps.length === 0) {
    startedAt = new Date();
    await ctx.db.insert(steps).values({
      id: dbStepId,
      runId: ctx.runId,
      kind: 'workflow_step',
      name: `${step.kind}:${step.id}`,
      status: 'running',
      startedAt,
    });
    ctx.emit({
      type: 'step_started',
      runId: ctx.runId,
      timestamp: Date.now(),
      stepId: step.id,
      kind: 'wait_event',
    });
  } else {
    startedAt = existingSteps[0]!.startedAt as unknown as Date;
  }

  // Check the events table for a matching row.
  const matching = await ctx.db
    .select()
    .from(events)
    .where(and(eq(events.kind, step.event_kind), gte(events.createdAt, startedAt)));

  const found = matching.find((row) => matchesPayload(row.payload, step.match));

  if (found) {
    let payload: unknown;
    try {
      payload = JSON.parse(found.payload);
    } catch {
      payload = found.payload;
    }
    const outputRef = await ctx.blobs.write(found.payload);
    await markStepSucceededWithRef(ctx, dbStepId, outputRef);
    ctx.state.completedStepIds.add(step.id);
    ctx.state.outputs.set(step.id, payload);
    ctx.emit({
      type: 'step_completed',
      runId: ctx.runId,
      timestamp: Date.now(),
      stepId: step.id,
      kind: 'wait_event',
      output: payload,
    });
    return;
  }

  // Timeout check.
  if (step.timeout_ms !== undefined) {
    const deadline = startedAt.getTime() + step.timeout_ms;
    if (Date.now() >= deadline) {
      const msg = `wait_event "${step.event_kind}" timed out after ${step.timeout_ms}ms`;
      await markStepFailed(ctx, dbStepId, msg);
      ctx.emit({
        type: 'step_failed',
        runId: ctx.runId,
        timestamp: Date.now(),
        stepId: step.id,
        kind: 'wait_event',
        error: msg,
      });
      throw new StepFailure(msg, step.id);
    }
  }

  // No match yet — park the run.
  ctx.emit({
    type: 'awaiting_event',
    runId: ctx.runId,
    timestamp: Date.now(),
    stepId: step.id,
    eventKind: step.event_kind,
    ...(step.match ? { match: step.match } : {}),
  });
  await ctx.db.update(runs).set({ status: 'pending' }).where(eq(runs.id, ctx.runId));
  throw new WorkflowPause('wait_event', step.id);
}

async function executeSequenceStep(step: SequenceStepDef, ctx: ExecutorCtx): Promise<void> {
  const dbStepId = scopedStepId(ctx.runId, step.id);
  await upsertStepRunning(ctx, step.id, 'workflow_step', step.kind, null);
  ctx.emit({
    type: 'step_started',
    runId: ctx.runId,
    timestamp: Date.now(),
    stepId: step.id,
    kind: 'sequence',
  });
  await executeSteps(step.steps, ctx);
  await markStepSucceeded(ctx, dbStepId, null);
  ctx.state.completedStepIds.add(step.id);
  ctx.emit({
    type: 'step_completed',
    runId: ctx.runId,
    timestamp: Date.now(),
    stepId: step.id,
    kind: 'sequence',
  });
}

// ---------------------------------------------------------------------------
// State / persistence helpers
// ---------------------------------------------------------------------------

export function scopedStepId(runId: string, stepId: string): string {
  return `${runId}:${stepId}`;
}

async function rehydrateState(
  db: AgentOsDb,
  blobs: BlobStore,
  runId: string,
  def: WorkflowDef,
): Promise<WorkflowRunState> {
  const existing = await db.select().from(steps).where(eq(steps.runId, runId));
  const completed = new Set<string>();
  const outputs = new Map<string, unknown>();
  let currentStepId: string | undefined;

  for (const row of existing) {
    const scopedId = row.id.startsWith(`${runId}:`) ? row.id.slice(runId.length + 1) : row.id;
    if (row.status === 'succeeded') {
      completed.add(scopedId);
      if (row.outputRef) {
        try {
          const buf = await blobs.read(row.outputRef);
          const parsed = JSON.parse(buf.toString('utf8'));
          // For agent steps the blob is `{ output }`; for wait_event it's the
          // raw event payload. Normalise by checking for the wrapper.
          if (
            parsed !== null &&
            typeof parsed === 'object' &&
            'output' in (parsed as Record<string, unknown>) &&
            Object.keys(parsed as Record<string, unknown>).length === 1
          ) {
            outputs.set(scopedId, (parsed as { output: unknown }).output);
          } else {
            outputs.set(scopedId, parsed);
          }
        } catch {
          // If a blob is unreadable, leave the output unset; downstream
          // interpolation will surface the issue.
        }
      }
    } else if (row.status === 'running' || row.status === 'pending') {
      currentStepId = scopedId;
    }
  }

  return {
    runId,
    workflowId: def.id,
    status: 'running',
    completedStepIds: completed,
    outputs,
    ...(currentStepId !== undefined ? { currentStepId } : {}),
  };
}

async function upsertStepRunning(
  ctx: ExecutorCtx,
  stepId: string,
  dbKind: 'workflow_step' | 'approval' | 'subagent',
  variantName: string,
  inputRef: string | null,
): Promise<void> {
  const id = scopedStepId(ctx.runId, stepId);
  const existing = await ctx.db.select().from(steps).where(eq(steps.id, id));
  if (existing.length === 0) {
    await ctx.db.insert(steps).values({
      id,
      runId: ctx.runId,
      kind: dbKind,
      name: `${variantName}:${stepId}`,
      status: 'running',
      startedAt: new Date(),
      ...(inputRef ? { inputRef } : {}),
    });
    return;
  }
  // If the row is already there but not succeeded, reset it to running for
  // this attempt (retry-after-pause case).
  const row = existing[0]!;
  if (row.status !== 'succeeded') {
    await ctx.db
      .update(steps)
      .set({ status: 'running', error: null, endedAt: null })
      .where(eq(steps.id, id));
  }
}

async function markStepSucceeded(
  ctx: ExecutorCtx,
  dbStepId: string,
  outputRef: string | null,
): Promise<void> {
  await ctx.db
    .update(steps)
    .set({
      status: 'succeeded',
      endedAt: new Date(),
      ...(outputRef ? { outputRef } : {}),
    })
    .where(eq(steps.id, dbStepId));
}

// Same as markStepSucceeded but always sets the output_ref (used by
// wait_event whose ref is the event payload blob).
async function markStepSucceededWithRef(
  ctx: ExecutorCtx,
  dbStepId: string,
  outputRef: string,
): Promise<void> {
  await ctx.db
    .update(steps)
    .set({ status: 'succeeded', endedAt: new Date(), outputRef })
    .where(eq(steps.id, dbStepId));
}

async function markStepFailed(ctx: ExecutorCtx, dbStepId: string, error: string): Promise<void> {
  await ctx.db
    .update(steps)
    .set({ status: 'failed', endedAt: new Date(), error })
    .where(eq(steps.id, dbStepId));
}

// ---------------------------------------------------------------------------
// Expression / interpolation helpers
// ---------------------------------------------------------------------------

/**
 * Interpolate `${inputs.x}` and `${outputs['id'].path}` references in a
 * goal template. Anything else is left untouched.
 */
export function interpolate(template: string, state: WorkflowRunState): string {
  return template.replace(/\$\{([^}]+)\}/g, (_, expr: string) => {
    try {
      const value = evaluateExpression(expr.trim(), state);
      return value === undefined || value === null
        ? ''
        : typeof value === 'string'
          ? value
          : JSON.stringify(value);
    } catch {
      return '';
    }
  });
}

/**
 * Evaluate a JS-like expression in a constrained scope containing only
 * `inputs` and `outputs`. Used for `conditional.when` and `${...}` interp.
 *
 * Security: this is a literal `new Function` eval against a fixed scope. The
 * workflow YAML is local, authored by the user, and runs in their own
 * environment; we explicitly trade sandboxing for expressiveness here. Do
 * NOT pass untrusted workflow definitions to the executor.
 */
export function evaluateExpression(expression: string, state: WorkflowRunState): unknown {
  const inputs = (state.outputs.get('__inputs__') ?? {}) as Record<string, unknown>;
  const outputs: Record<string, unknown> = {};
  for (const [k, v] of state.outputs) {
    if (k === '__inputs__') continue;
    outputs[k] = v;
  }
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function('inputs', 'outputs', `return (${expression});`);
  return fn(inputs, outputs);
}

function matchesPayload(payloadJson: string, match: Record<string, unknown> | undefined): boolean {
  if (!match) return true;
  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return false;
  }
  if (payload === null || typeof payload !== 'object') return false;
  for (const [k, v] of Object.entries(match)) {
    if ((payload as Record<string, unknown>)[k] !== v) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Misc utilities
// ---------------------------------------------------------------------------

function combineSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted) return a;
  if (b.aborted) return b;
  const ctl = new AbortController();
  const onA = (): void => ctl.abort(a.reason);
  const onB = (): void => ctl.abort(b.reason);
  a.addEventListener('abort', onA, { once: true });
  b.addEventListener('abort', onB, { once: true });
  return ctl.signal;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
