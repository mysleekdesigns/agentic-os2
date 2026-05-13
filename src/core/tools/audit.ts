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
 * Env-var names whose live values are stripped from any string before the
 * pattern-based scrubbers run (PRD §3 Phase 11 — Secrets handling).
 *
 * The list is intentionally short and provider-shaped: a future adapter that
 * lands a new key env-var should extend it here. We keep it conservative so
 * `redactSecrets` does not turn into a generic env-redactor — that would
 * surprise operators whose unrelated env contains common substrings.
 */
const GUARDED_ENV_NAMES: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'CLAUDE_API_KEY',
];

/**
 * Minimum length below which a guarded env value is ignored for substring
 * redaction. Real Anthropic/OpenAI keys are far longer than this; the guard
 * is cheap defence against accidentally redacting an unrelated short value
 * that happens to share a name with a key env-var in a test.
 */
const MIN_GUARDED_SECRET_LEN = 12;

/**
 * Build the live set of guarded secret values from `env` (defaults to
 * `process.env`). Resolved per `redactSecrets` call rather than cached at
 * module load: a long-lived process may have an env-var injected, rotated,
 * or unset between calls, and stale caching would leak the newer key or
 * waste work scrubbing a value that is no longer secret.
 *
 * Filters out empty values and values below `MIN_GUARDED_SECRET_LEN`.
 * De-duplicates so the substitution pass touches the string once per
 * distinct secret.
 */
export function getGuardedSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  const seen = new Set<string>();
  for (const name of GUARDED_ENV_NAMES) {
    const v = env[name];
    if (typeof v !== 'string') continue;
    if (v.length < MIN_GUARDED_SECRET_LEN) continue;
    seen.add(v);
  }
  return [...seen];
}

/**
 * Recursively redact common secret shapes from a JSON-serialisable value.
 *
 * Three complementary passes:
 *  - live env-var values (PRD Phase 11) for the providers in
 *    `GUARDED_ENV_NAMES` → matched substring replaced with `<redacted>`
 *    (catches a raw `ANTHROPIC_API_KEY` accidentally echoed into a header or
 *    tool result, regardless of surrounding context)
 *  - object keys matching SECRET_KEY_RE → value replaced with `<redacted>`
 *    (catches `api_key`, `password`, `auth_token`, etc. regardless of value)
 *  - string values matching SECRET_VALUE_RES → matched substring replaced with
 *    `<redacted>` (catches credentials embedded in args/results/URLs)
 *
 * The env pass runs first because a live key value is the strongest signal
 * and we want it scrubbed even if the surrounding pattern heuristics fail.
 *
 * Pure: returns a new value tree; the input is not mutated. The optional
 * `env` argument lets tests inject a synthetic env; production callers should
 * omit it so `process.env` is read at call time (env mutability — see
 * `getGuardedSecrets`). Phase 4 ships a coarse passlist; Phase 12 (PRD §2.5)
 * will move the rules into config.
 */
export function redactSecrets(value: unknown, env?: NodeJS.ProcessEnv): unknown {
  const secrets = getGuardedSecrets(env);
  return redactWith(value, secrets, true);
}

/**
 * Like `redactSecrets`, but skips the key-name pass. Use when the keys are
 * known-safe (e.g. OTel GenAI attribute names such as
 * `gen_ai.usage.input_tokens`, which contain the substring "token" purely as
 * part of a metric name). String values still run through both env-value and
 * vendor-pattern scrubbing.
 *
 * Added in Phase 11 so the span emitter can scrub leaked env-var values from
 * persisted trace attributes without falsely redacting standardised metric
 * keys.
 */
export function redactSecretValues(value: unknown, env?: NodeJS.ProcessEnv): unknown {
  const secrets = getGuardedSecrets(env);
  return redactWith(value, secrets, false);
}

function redactWith(value: unknown, secrets: readonly string[], keyPass: boolean): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value, secrets);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((v) => redactWith(v, secrets, keyPass));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (keyPass && SECRET_KEY_RE.test(k)) {
      out[k] = REDACTED;
    } else {
      out[k] = redactWith(v, secrets, keyPass);
    }
  }
  return out;
}

function redactString(s: string, secrets: readonly string[] = getGuardedSecrets()): string {
  let out = s;
  // Strip raw env-var values first so the pattern-based scrubbers below never
  // see a leaked key in passing (e.g. an `sk-…` value that happened to fall
  // just under the pattern's minimum length).
  for (const secret of secrets) {
    if (secret.length < MIN_GUARDED_SECRET_LEN) continue;
    // `split/join` performs a literal (non-regex) global replacement, which
    // is what we want — secret values may contain regex metacharacters.
    if (out.includes(secret)) {
      out = out.split(secret).join(REDACTED);
    }
  }
  for (const re of SECRET_VALUE_RES) {
    out = out.replace(re, REDACTED);
  }
  return out;
}
