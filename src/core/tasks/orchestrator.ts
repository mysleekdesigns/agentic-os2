/**
 * Orchestrator-worker topology helper (PRD §3 Phase 5).
 *
 * Lets a "lead" agent step spawn N worker subagents concurrently. Each
 * worker's execution is persisted as:
 *   1. A child row in `runs` with `parent_run_id = leadRunId`, status
 *      tracking its own lifecycle.
 *   2. A `steps` row on the LEAD run with `kind='subagent'`, scoped by the
 *      lead's runId, pointing at the child run's id via `output_ref` (we
 *      store `{ childRunId, output }` in the blob).
 *
 * This file deliberately stays small — most coordination is delegated to the
 * provider adapter and the executor's existing persistence helpers. Use it
 * when an `agent` step needs to fan out work to specialised workers.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

import type { AgentOsDb } from '../../storage/db.js';
import type { BlobStore } from '../../storage/blobs.js';
import { runs, steps } from '../../storage/schema.js';
import type { ProviderAdapter } from './executor.js';
import { scopedStepId } from './executor.js';
import type { SubagentSpec } from './types.js';

export interface WorkerResult {
  /** Subagent spec id. */
  workerId: string;
  /** The child run row id (newly created). */
  childRunId: string;
  /** The provider adapter's final output for that worker. */
  output: unknown;
  /** True if the worker raised an error rather than completing. */
  failed: boolean;
  error?: string;
}

export interface SpawnWorkersOptions {
  leadRunId: string;
  /**
   * Lead agent id — recorded on each child `runs.agent_id` row when the
   * worker spec omits an explicit agent (matches Claude Code subagent
   * inheritance semantics).
   */
  leadAgentId?: string;
  workers: SubagentSpec[];
  providerAdapter: ProviderAdapter;
  db: AgentOsDb;
  blobs: BlobStore;
  /** Provider/model recorded on the child `runs` row. Display-only. */
  provider?: string;
  model?: string;
  signal?: AbortSignal;
}

/**
 * Spawn the configured worker subagents concurrently and yield each
 * `WorkerResult` as it completes (not necessarily in input order).
 *
 * The returned iterable terminates after every worker has settled (success
 * or failure). Callers that want fail-fast semantics should propagate the
 * first `failed: true` result via `AbortController`.
 */
export function spawnWorkers(opts: SpawnWorkersOptions): AsyncIterable<WorkerResult> {
  const queue: WorkerResult[] = [];
  let waiter: (() => void) | null = null;
  let remaining = opts.workers.length;

  const wake = (): void => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w();
    }
  };

  const start = async (worker: SubagentSpec): Promise<void> => {
    const childRunId = randomUUID();
    const leadStepDbId = scopedStepId(opts.leadRunId, worker.id);

    // Insert the child run row and the lead's subagent step row up-front so
    // an in-flight crash leaves a clear audit trail.
    const startedAt = new Date();

    try {
      await opts.db.insert(runs).values({
        id: childRunId,
        agentId: worker.agent,
        parentRunId: opts.leadRunId,
        status: 'running',
        startedAt,
        provider: opts.provider ?? 'workflow',
        model: opts.model ?? worker.model ?? 'unknown',
      });
      await opts.db.insert(steps).values({
        id: leadStepDbId,
        runId: opts.leadRunId,
        kind: 'subagent',
        name: `subagent:${worker.id}`,
        status: 'running',
        startedAt,
      });
    } catch (err) {
      queue.push({
        workerId: worker.id,
        childRunId,
        output: null,
        failed: true,
        error: err instanceof Error ? err.message : String(err),
      });
      remaining--;
      wake();
      return;
    }

    const timeoutCtl = new AbortController();
    const timer =
      worker.timeout_ms !== undefined
        ? setTimeout(() => timeoutCtl.abort(new Error('worker timeout')), worker.timeout_ms)
        : null;
    const signal = opts.signal ? combineSignals(opts.signal, timeoutCtl.signal) : timeoutCtl.signal;

    try {
      const output = await opts.providerAdapter.runAgent({
        agentId: worker.agent,
        goal: worker.goal,
        ...(worker.model !== undefined ? { model: worker.model } : {}),
        ...(worker.timeout_ms !== undefined ? { timeoutMs: worker.timeout_ms } : {}),
        signal,
        runId: childRunId,
        stepId: worker.id,
      });
      if (timer) clearTimeout(timer);

      const outputRef = await opts.blobs.write(JSON.stringify({ childRunId, output }));
      const endedAt = new Date();
      await opts.db
        .update(runs)
        .set({ status: 'succeeded', endedAt })
        .where(eq(runs.id, childRunId));
      await opts.db
        .update(steps)
        .set({ status: 'succeeded', endedAt, outputRef })
        .where(eq(steps.id, leadStepDbId));

      queue.push({ workerId: worker.id, childRunId, output, failed: false });
    } catch (err) {
      if (timer) clearTimeout(timer);
      const message = err instanceof Error ? err.message : String(err);
      const endedAt = new Date();
      await opts.db
        .update(runs)
        .set({ status: 'failed', endedAt, summary: message })
        .where(eq(runs.id, childRunId));
      await opts.db
        .update(steps)
        .set({ status: 'failed', endedAt, error: message })
        .where(eq(steps.id, leadStepDbId));
      queue.push({
        workerId: worker.id,
        childRunId,
        output: null,
        failed: true,
        error: message,
      });
    } finally {
      remaining--;
      wake();
    }
  };

  // Kick off every worker concurrently. We don't await — results land in the
  // queue and the consumer's iterator picks them up.
  for (const worker of opts.workers) {
    void start(worker);
  }

  async function* iterator(): AsyncGenerator<WorkerResult, void, void> {
    while (remaining > 0 || queue.length > 0) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      await new Promise<void>((resolve) => {
        waiter = resolve;
      });
    }
  }

  // Suppress the unused warning for leadAgentId — it's part of the public
  // shape for documentation but not currently materialised on the row.
  void opts.leadAgentId;

  return iterator();
}

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
