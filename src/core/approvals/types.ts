/**
 * Approval queue types (PRD §3 Phase 6).
 *
 * Pure data types — no dependencies on Drizzle/db. The queue module
 * (`./index.ts`) maps these to `approvals` rows; the policy module
 * (`./policies.ts`) consumes the policies shape.
 */

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface ApprovalRequest {
  id: string;
  runId: string | null;
  stepId: string | null;
  requestedBy: string;
  /** Tool name, workflow approval-step prompt, or other free-form action. */
  action: string;
  reason: string | null;
  /** Unix epoch seconds. */
  requestedAt: number;
  /** Unix epoch seconds; null = no expiry. */
  expiresAt: number | null;
  note: string | null;
  /** Set when a reviewer issued a `revise` decision; null otherwise. */
  revisedAction: string | null;
  status: ApprovalStatus;
  decidedBy: string | null;
  /** Unix epoch seconds. */
  decidedAt: number | null;
}

export type DecisionVerdict = 'approve' | 'reject' | 'revise';

export interface DecisionInput {
  approvalId: string;
  verdict: DecisionVerdict;
  /** User/agent id; CLI default 'cli-user'. */
  decidedBy: string;
  note?: string;
  /** Required when verdict === 'revise'. */
  revisedAction?: string;
  /** Override for tests; default `Math.floor(Date.now() / 1000)`. */
  at?: number;
}

export interface CreateRequestInput {
  runId?: string | null;
  stepId?: string | null;
  requestedBy: string;
  action: string;
  reason?: string | null;
  /** `null` = no TTL; absent = use the config default. */
  ttlSeconds?: number | null;
  /** Override for deterministic tests. */
  id?: string;
  /** Override for deterministic tests (unix epoch seconds). */
  at?: number;
}
