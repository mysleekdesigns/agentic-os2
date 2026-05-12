/**
 * Memory access policy (PRD §3 Phase 7 — Exit criterion).
 *
 * Pure policy enforcement at the provider boundary. Every read / write /
 * search / delete against a memory scope flows through `enforceMemoryAccess`
 * (or its throwing wrapper). Denials are logged to the supplied
 * `eventLogger` with `kind='memory.denied'` so the audit log records every
 * blocked attempt — this is the load-bearing artefact for the Exit test:
 *
 *   "An agent without `memory.write: notes` cannot create a `notes` memory
 *    even if it tries; the attempt is logged."
 *
 * Rules:
 *   - `read | list | show | search` against a scope NOT in `agent.memory.read`
 *     → deny.
 *   - `write` against a scope NOT in `agent.memory.write` → deny.
 *   - `rm` is a write (tombstone) → same rule as `write`.
 *   - Allow lists are EXACT-MATCH scope names. No wildcards yet. Revisit in
 *     Phase 12 once we have multi-tenant scopes (PRD §3 Phase 12).
 */

import { randomUUID } from 'node:crypto';

import type { AgentFrontmatter } from '../agents/schema.js';
import type { MemoryAction } from './types.js';

export interface MemoryPolicyDecision {
  outcome: 'allow' | 'deny';
  scope: string;
  action: MemoryAction;
  reason: string;
}

export interface MemoryEventLogger {
  /**
   * Emits an event row to the audit log. Implementations typically insert
   * into the `events` table; tests pass a recording stub.
   */
  emit(args: { kind: string; payload: Record<string, unknown>; at: number }): Promise<void> | void;
}

export interface EnforceMemoryAccessArgs {
  agent: AgentFrontmatter;
  action: MemoryAction;
  scope: string;
  /** Override for deterministic tests; default `Math.floor(Date.now()/1000)`. */
  at?: number;
  /** Optional sink for `memory.denied` events. */
  eventLogger?: MemoryEventLogger;
}

const WRITE_ACTIONS: ReadonlySet<MemoryAction> = new Set(['write', 'rm']);
const READ_ACTIONS: ReadonlySet<MemoryAction> = new Set(['list', 'show', 'read', 'search']);

/**
 * Evaluate whether `agent` may perform `action` against `scope`. Returns the
 * decision and (on deny) emits `memory.denied` to the supplied event logger.
 *
 * Pure aside from the (optional) event emission — this function does not
 * touch the database directly.
 */
export function enforceMemoryAccess(args: EnforceMemoryAccessArgs): MemoryPolicyDecision {
  const { agent, action, scope } = args;

  const allowed = WRITE_ACTIONS.has(action)
    ? (agent.memory.write ?? []).includes(scope)
    : (agent.memory.read ?? []).includes(scope);

  if (allowed) {
    return {
      outcome: 'allow',
      scope,
      action,
      reason: WRITE_ACTIONS.has(action)
        ? `scope '${scope}' is in agent.memory.write`
        : `scope '${scope}' is in agent.memory.read`,
    };
  }

  const reason = WRITE_ACTIONS.has(action)
    ? `scope '${scope}' is not in agent.memory.write`
    : READ_ACTIONS.has(action)
      ? `scope '${scope}' is not in agent.memory.read`
      : `unknown memory action: ${String(action)}`;

  const decision: MemoryPolicyDecision = {
    outcome: 'deny',
    scope,
    action,
    reason,
  };

  if (args.eventLogger) {
    const at = args.at ?? Math.floor(Date.now() / 1000);
    void args.eventLogger.emit({
      kind: 'memory.denied',
      payload: {
        memory_event_id: randomUUID(),
        agent_id: agent.id,
        action,
        scope,
        reason,
        when: at,
      },
      at,
    });
  }

  return decision;
}

/**
 * Typed error thrown by `enforceMemoryAccessOrThrow` when access is denied.
 * Callers (executor / interceptor) can `instanceof`-match this without
 * relying on string parsing.
 */
export class MemoryPolicyDenied extends Error {
  public readonly decision: MemoryPolicyDecision;

  constructor(decision: MemoryPolicyDecision) {
    super(
      `memory access denied: agent action='${decision.action}' scope='${decision.scope}' — ${decision.reason}`,
    );
    this.name = 'MemoryPolicyDenied';
    this.decision = decision;
  }
}

/**
 * Throwing wrapper. Returns the (allow) decision on success; throws
 * `MemoryPolicyDenied` on denial. Logs the denial via `eventLogger` exactly
 * once (deferring to `enforceMemoryAccess`).
 */
export function enforceMemoryAccessOrThrow(args: EnforceMemoryAccessArgs): MemoryPolicyDecision {
  const decision = enforceMemoryAccess(args);
  if (decision.outcome === 'deny') {
    throw new MemoryPolicyDenied(decision);
  }
  return decision;
}
