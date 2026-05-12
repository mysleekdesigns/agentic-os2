/**
 * SQLite-backed `ToolAuditor` (PRD §2.4, §2.5, Phase 4 Bundle B).
 *
 * Persists every tool call as a `tool_calls` row, with `args` and `result`
 * payloads off-loaded to the content-addressed `BlobStore`. The schema requires
 * `tool_calls.step_id NOT NULL` and `steps.run_id NOT NULL`, so the auditor
 * eagerly writes a parent `runs` row and a single `steps` row at construction
 * time. Phase 5 will subdivide steps; for now one step covers all tool calls
 * for the run.
 */

import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';

import type { AgentOsDb } from '../../storage/db.js';
import type { BlobStore } from '../../storage/blobs.js';
import {
  agents,
  runs,
  steps,
  toolCalls,
  type RiskLevel,
  type ToolCallStatus,
} from '../../storage/schema.js';
import { stableHash, type ToolAuditor } from './interceptor.js';

export interface SqliteAuditorOptions {
  db: AgentOsDb;
  blobs: BlobStore;
  agentId: string;
  /** Optional override of the run id (default: `randomUUID()`). */
  runId?: string;
  provider: string;
  model: string;
  /**
   * When true, args and results are scrubbed of common secret shapes before
   * being written to the blob store (PRD §2.5 `redact_secrets_in_logs`).
   * Phase 4 ships a coarse passlist; Phase 12 owns configurable regex rules.
   * Defaults to `true` — the config schema also defaults to `true`, so the
   * auditor matches the operator-facing contract by default.
   */
  redactSecrets?: boolean;
}

export interface SqliteAuditor extends ToolAuditor {
  /** Mark the run as succeeded/failed/cancelled and set `ended_at`. */
  finalize(reason: 'completed' | 'cancelled' | 'error'): Promise<void>;
  /** The persisted run id (handy for tests). */
  readonly runId: string;
  /** The persisted step id (single step covers all tool calls in this build). */
  readonly stepId: string;
}

/**
 * Construct an auditor and write the parent `runs` and `steps` rows eagerly.
 *
 * The schema requires `runs.agent_id` to FK to `agents.id`, so we upsert an
 * agents row if one does not yet exist. This matches the behaviour of
 * `agent sync` and means the auditor can run before sync has been called.
 */
export async function createSqliteAuditor(opts: SqliteAuditorOptions): Promise<SqliteAuditor> {
  const runId = opts.runId ?? randomUUID();
  const stepId = randomUUID();
  const now = new Date();
  const redact = opts.redactSecrets !== false;
  const scrub = (value: unknown): unknown => (redact ? redactSecrets(value) : value);

  // Ensure the agents row exists so the runs.agent_id FK does not fail. We
  // only write a minimal placeholder — the real `agent sync` flow owns the
  // canonical row.
  const existingAgent = await opts.db.select().from(agents).where(eq(agents.id, opts.agentId));
  if (existingAgent.length === 0) {
    await opts.db.insert(agents).values({
      id: opts.agentId,
      version: '0',
      definitionPath: '',
      hash: '',
      createdAt: now,
    });
  }

  await opts.db.insert(runs).values({
    id: runId,
    agentId: opts.agentId,
    status: 'running',
    startedAt: now,
    provider: opts.provider,
    model: opts.model,
  });

  await opts.db.insert(steps).values({
    id: stepId,
    runId,
    kind: 'tool_call',
    name: 'phase-4-tool-calls',
    status: 'running',
    startedAt: now,
  });

  // Per-tool-call row id mapping so `onResult` can update the right row.
  const rowIdFor = new Map<string, string>();

  return {
    runId,
    stepId,

    async onCall(record) {
      const argsRef = await opts.blobs.write(stableJson(scrub(record.args)));
      const callRowId = randomUUID();
      rowIdFor.set(record.toolCallId, callRowId);

      const status: ToolCallStatus =
        record.decision === 'allow'
          ? 'approved'
          : record.decision === 'approval_required'
            ? 'approved'
            : 'rejected';

      await opts.db.insert(toolCalls).values({
        id: callRowId,
        stepId,
        tool: record.tool,
        argsRef,
        risk: record.risk as RiskLevel,
        ...(record.decidedBy !== undefined ? { approvedBy: record.decidedBy } : {}),
        status,
      });
    },

    async onResult(record) {
      const rowId = rowIdFor.get(record.toolCallId);
      if (rowId === undefined) {
        // No corresponding onCall — silently ignore. This should not happen in
        // the standard interceptor flow but we want the auditor to be robust
        // to misuse by future callers.
        return;
      }
      const resultRef = await opts.blobs.write(stableJson(scrub(record.result)));
      const finalStatus: ToolCallStatus = record.isError === true ? 'failed' : 'succeeded';
      await opts.db
        .update(toolCalls)
        .set({
          resultRef,
          latencyMs: record.latencyMs,
          status: finalStatus,
        })
        .where(eq(toolCalls.id, rowId));
    },

    async finalize(reason) {
      const status =
        reason === 'completed' ? 'succeeded' : reason === 'cancelled' ? 'cancelled' : 'failed';
      const endedAt = new Date();
      await opts.db
        .update(steps)
        .set({ status: reason === 'completed' ? 'succeeded' : 'failed', endedAt })
        .where(eq(steps.id, stepId));
      await opts.db.update(runs).set({ status, endedAt }).where(eq(runs.id, runId));
    },
  };
}

/** JSON encoding mirroring `stableHash`'s key-sort discipline (string output). */
function stableJson(value: unknown): string {
  if (value === undefined) return JSON.stringify(null);
  // Sorting replacer keeps payload bytes (and hence blob hashes) deterministic
  // across runs regardless of object key insertion order.
  return JSON.stringify(value, sortReplacer);
}

function sortReplacer(_key: string, val: unknown): unknown {
  if (val === null || typeof val !== 'object' || Array.isArray(val)) return val;
  const obj = val as Record<string, unknown>;
  return Object.keys(obj)
    .sort()
    .reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = obj[k];
      return acc;
    }, {});
}

// Re-export `stableHash` for tests/callers that want the same digest the
// auditor would produce.
export { stableHash };

// ---------------------------------------------------------------------------
// Secret redaction (PRD §2.5 `redact_secrets_in_logs`)
// ---------------------------------------------------------------------------

const REDACTED = '<redacted>';

/** Object keys whose values are always redacted regardless of content. */
const SECRET_KEY_RE = /key|token|secret|password|passwd|auth|credential|bearer/i;

/** String-value patterns that look like vendor credentials and are scrubbed wholesale. */
const SECRET_VALUE_RES: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic-style
  /\bAIza[0-9A-Za-z_-]{20,}/g, // Google API key
  /\bghp_[A-Za-z0-9]{20,}/g, // GitHub classic PAT
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PAT
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /\bBearer\s+[A-Za-z0-9._\-+/=]{16,}/gi, // HTTP Authorization
];

/**
 * Recursively redact common secret shapes from a JSON-serialisable value.
 *
 * Two complementary passes:
 *  - object keys matching SECRET_KEY_RE → value replaced with `<redacted>`
 *    (catches `api_key`, `password`, `auth_token`, etc. regardless of value)
 *  - string values matching SECRET_VALUE_RES → matched substring replaced with
 *    `<redacted>` (catches credentials embedded in args/results/URLs)
 *
 * Pure: returns a new value tree; the input is not mutated. Phase 4 ships a
 * coarse passlist — Phase 12 (PRD §2.5) will move the rules into config.
 */
export function redactSecrets(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((v) => redactSecrets(v));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(k)) {
      out[k] = REDACTED;
    } else {
      out[k] = redactSecrets(v);
    }
  }
  return out;
}

function redactString(s: string): string {
  let out = s;
  for (const re of SECRET_VALUE_RES) {
    out = out.replace(re, REDACTED);
  }
  return out;
}
