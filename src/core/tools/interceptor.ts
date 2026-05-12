/**
 * Provider-stream interceptor (PRD §1.7, §2.5, Phase 4 Bundle B).
 *
 * Wraps a `Provider.run()` event stream and enforces the pure policy core
 * exported by `./policy.ts` at every `tool_call`. Allowed calls pass through;
 * denials and approval-required outcomes are surfaced as `approval_requested`
 * events plus a synthetic `tool_result { isError: true }` so the model and the
 * transcript renderer observe a clean call/result pair.
 *
 * No I/O — the auditor side-effect is delegated to the injected `ToolAuditor`.
 * Approval prompts are delegated to the injected `ApprovalResolver`. Both have
 * conservative no-op / reject defaults so the interceptor is safe to use in
 * non-interactive contexts (CI, tests).
 */

import { createHash } from 'node:crypto';

import type { SecurityConfig } from '../../config/schema.js';
import type { AgentFrontmatter } from '../agents/schema.js';
import type { AgentRunInput, Provider, RunEvent } from '../providers/index.js';
import type { AgentOsDb } from '../../storage/db.js';
import { createRequest as createApprovalRequest } from '../approvals/index.js';
import { evaluate, type PolicyDecision } from './policy.js';

export interface ApprovalContext {
  toolCallId: string;
  tool: string;
  args: unknown;
  decision: PolicyDecision;
}

/** Pluggable approval resolver. Returns `'approve'` or `'reject'`. */
export type ApprovalResolver = (ctx: ApprovalContext) => Promise<'approve' | 'reject'>;

/** Auditor for tool-call lifecycle events (Bundle B writes the DB implementation). */
export interface ToolAuditor {
  onCall(record: {
    toolCallId: string;
    tool: string;
    args: unknown;
    risk: PolicyDecision['risk'];
    decision: PolicyDecision['outcome'];
    rule: PolicyDecision['rule'];
    reason: string;
    decidedBy?: string;
  }): Promise<void> | void;
  onResult(record: {
    toolCallId: string;
    result?: unknown;
    isError?: boolean;
    latencyMs: number;
  }): Promise<void> | void;
}

/**
 * How `approval_required` decisions are dispatched.
 *
 * - `'inline'` (default, Phase 4 behaviour): the interceptor calls the
 *   provided `ApprovalResolver` synchronously and acts on the verdict.
 * - `'queue'` (Phase 6): the interceptor persists the request to the
 *   `approvals` table via `createRequest`, emits `approval_requested`, then
 *   short-circuits with a synthetic deny-style `tool_result` carrying the
 *   queued approval id. The caller (typically the workflow executor) is
 *   responsible for pausing the run; the interceptor itself does NOT wait
 *   for the decision and does NOT poll.
 */
export type ApprovalMode = 'inline' | 'queue';

/**
 * Required when `mode === 'queue'`. The interceptor uses these to persist
 * approval rows and emit `approval.requested` audit events.
 */
export interface QueueApprovalOptions {
  db: AgentOsDb;
  /** Used as `requested_by` on the approval row. */
  requestedBy: string;
  /** Linked to `approvals.run_id`. */
  runId?: string | null;
  /** Linked to `approvals.step_id`. */
  stepId?: string | null;
  /** Fallback TTL when no per-tool/agent override applies. */
  defaultTtlSeconds?: number | null;
}

export interface InterceptOptions {
  agent: Pick<AgentFrontmatter, 'id' | 'tools' | 'permissions'>;
  security: SecurityConfig;
  /** Defaults to auto-reject (deny) when omitted. */
  approvalResolver?: ApprovalResolver;
  /** Defaults to a no-op auditor when omitted. */
  auditor?: ToolAuditor;
  /** Approval dispatch mode (default `'inline'`). */
  mode?: ApprovalMode;
  /** Required when `mode === 'queue'`. */
  queue?: QueueApprovalOptions;
}

/**
 * Deterministic sha256 over a JSON-serialisable value. Object keys are sorted
 * recursively so that {a:1,b:2} and {b:2,a:1} hash to the same digest. Used by
 * auditors that want to record content-addressed pointers to args / results.
 */
export function stableHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v) => stableStringify(v)).join(',') + ']';
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return (
    '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + stableStringify(v)).join(',') + '}'
  );
}

/**
 * Wrap a provider's event stream and enforce policy on every `tool_call`.
 *
 * Event rewrite rules:
 * - decision=allow      → original `tool_call` passes through unchanged
 * - decision=deny       → emit `approval_requested` for visibility, then
 *                         emit a synthetic `tool_result { isError: true }`;
 *                         suppress the provider's later real `tool_result`
 *                         for the same id so the synthetic result is canonical
 * - decision=approval_required + approve → emit `approval_requested`, then
 *                         pass the original `tool_call` through
 * - decision=approval_required + reject  → emit `approval_requested`, then
 *                         emit a synthetic deny-style `tool_result`; suppress
 *                         the provider's real `tool_result` for the same id
 *
 * `tool_result` events also drive the auditor's `onResult` (with latency).
 * All other events pass through untouched.
 */
export function interceptProviderStream(
  provider: Provider,
  input: AgentRunInput,
  opts: InterceptOptions,
): AsyncIterable<RunEvent> {
  const resolver: ApprovalResolver = opts.approvalResolver ?? (async () => 'reject');
  const auditor: ToolAuditor = opts.auditor ?? noopAuditor;
  const mode: ApprovalMode = opts.mode ?? 'inline';
  if (mode === 'queue' && !opts.queue) {
    throw new Error('interceptProviderStream: mode="queue" requires queue options');
  }

  // Per-tool-call bookkeeping so we can compute latency at result-time and
  // drop the provider's real tool_result when we've already emitted a synthetic one.
  const startedAt = new Map<string, number>();
  const suppressedResultIds = new Set<string>();

  async function* iterator(): AsyncGenerator<RunEvent, void, void> {
    for await (const event of provider.run(input)) {
      if (event.type === 'tool_call') {
        const decision = evaluate({
          tool: event.tool,
          args: event.args,
          agent: opts.agent,
          security: opts.security,
        });

        if (decision.outcome === 'allow') {
          startedAt.set(event.toolCallId, event.timestamp);
          await auditor.onCall({
            toolCallId: event.toolCallId,
            tool: event.tool,
            args: event.args,
            risk: decision.risk,
            decision: decision.outcome,
            rule: decision.rule,
            reason: decision.reason,
            decidedBy: 'policy',
          });
          yield event;
          continue;
        }

        if (decision.outcome === 'deny') {
          await auditor.onCall({
            toolCallId: event.toolCallId,
            tool: event.tool,
            args: event.args,
            risk: decision.risk,
            decision: decision.outcome,
            rule: decision.rule,
            reason: decision.reason,
            decidedBy: 'policy',
          });
          yield syntheticApprovalRequested(event, decision.reason);
          const syntheticTs = event.timestamp + 1;
          yield syntheticDenyResult(event.toolCallId, decision.reason, syntheticTs);
          suppressedResultIds.add(event.toolCallId);
          await auditor.onResult({
            toolCallId: event.toolCallId,
            result: decision.reason,
            isError: true,
            latencyMs: 0,
          });
          continue;
        }

        // approval_required.
        //
        // In `'queue'` mode we persist the request via `createRequest` (which
        // emits an `approval.requested` event for the audit trail), surface
        // the in-stream `approval_requested` event for renderers, then
        // synthesize a deny-style `tool_result` carrying the queued approval
        // id. The caller decides what to do — typically pause the workflow.
        if (mode === 'queue') {
          const q = opts.queue!;
          const queued = await createApprovalRequest({
            db: q.db,
            requestedBy: q.requestedBy,
            action: event.tool,
            reason: decision.reason,
            runId: q.runId ?? null,
            stepId: q.stepId ?? null,
            ...(q.defaultTtlSeconds !== undefined
              ? { defaultTtlSeconds: q.defaultTtlSeconds }
              : {}),
          });
          await auditor.onCall({
            toolCallId: event.toolCallId,
            tool: event.tool,
            args: event.args,
            risk: decision.risk,
            decision: decision.outcome,
            rule: decision.rule,
            reason: decision.reason,
            // No decidedBy yet — decision is pending in the queue.
          });
          yield syntheticApprovalRequested(event, decision.reason);
          const syntheticTs = event.timestamp + 1;
          const queuedReason = `approval queued — id=${queued.id}`;
          yield syntheticDenyResult(event.toolCallId, queuedReason, syntheticTs);
          suppressedResultIds.add(event.toolCallId);
          await auditor.onResult({
            toolCallId: event.toolCallId,
            result: queuedReason,
            isError: true,
            latencyMs: 0,
          });
          continue;
        }

        // 'inline' mode: ask the resolver. We MUST NOT block the iterator
        // forever — the resolver is responsible for honouring any timeout.
        yield syntheticApprovalRequested(event, decision.reason);
        const verdict = await resolver({
          toolCallId: event.toolCallId,
          tool: event.tool,
          args: event.args,
          decision,
        });

        if (verdict === 'approve') {
          startedAt.set(event.toolCallId, event.timestamp);
          await auditor.onCall({
            toolCallId: event.toolCallId,
            tool: event.tool,
            args: event.args,
            risk: decision.risk,
            decision: decision.outcome,
            rule: decision.rule,
            reason: decision.reason,
            decidedBy: 'human',
          });
          yield event;
        } else {
          await auditor.onCall({
            toolCallId: event.toolCallId,
            tool: event.tool,
            args: event.args,
            risk: decision.risk,
            decision: decision.outcome,
            rule: decision.rule,
            reason: decision.reason,
            // No decidedBy when an approval is rejected — see PRD §2.5.
          });
          const syntheticTs = event.timestamp + 1;
          const rejectReason = `approval rejected: ${decision.reason}`;
          yield syntheticDenyResult(event.toolCallId, rejectReason, syntheticTs);
          suppressedResultIds.add(event.toolCallId);
          await auditor.onResult({
            toolCallId: event.toolCallId,
            result: rejectReason,
            isError: true,
            latencyMs: 0,
          });
        }
        continue;
      }

      if (event.type === 'tool_result') {
        if (suppressedResultIds.has(event.toolCallId)) {
          // Already replaced with a synthetic deny/reject result — drop it.
          suppressedResultIds.delete(event.toolCallId);
          continue;
        }
        const start = startedAt.get(event.toolCallId);
        const latencyMs = start !== undefined ? Math.max(0, event.timestamp - start) : 0;
        startedAt.delete(event.toolCallId);
        await auditor.onResult({
          toolCallId: event.toolCallId,
          result: event.result,
          ...(event.isError !== undefined ? { isError: event.isError } : {}),
          latencyMs,
        });
        yield event;
        continue;
      }

      yield event;
    }
  }

  return iterator();
}

const noopAuditor: ToolAuditor = {
  onCall: () => undefined,
  onResult: () => undefined,
};

function syntheticApprovalRequested(
  call: Extract<RunEvent, { type: 'tool_call' }>,
  reason: string,
): RunEvent {
  return {
    type: 'approval_requested',
    toolCallId: call.toolCallId,
    tool: call.tool,
    args: call.args,
    reason,
    timestamp: call.timestamp,
  };
}

function syntheticDenyResult(toolCallId: string, reason: string, timestamp: number): RunEvent {
  return {
    type: 'tool_result',
    toolCallId,
    result: reason,
    isError: true,
    timestamp,
  };
}
