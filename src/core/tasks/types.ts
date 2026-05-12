/**
 * Type contracts for the Agent OS workflow engine (PRD §3 Phase 5).
 *
 * The workflow engine consumes a `WorkflowDef` and emits a stream of
 * `WorkflowEvent`s while persisting state to the existing `runs`/`steps`/
 * `approvals`/`events` tables (PRD §2.4). This file is pure type material —
 * no runtime logic, no I/O — so it stays cheap to import from anywhere
 * (including downstream packages like the CLI).
 *
 * Design notes:
 * - `StepDef` is a discriminated union on `kind` matching the YAML schema.
 * - `WorkflowEvent` is a discriminated union on `type` so consumers can do
 *   exhaustive `switch` handling.
 * - Step ids are scoped to the workflow definition; the executor combines
 *   them with the `runId` to produce a deterministic, globally-unique
 *   `steps.id` (`${runId}:${stepId}`) so retries are idempotent.
 */

import type { RunStatus, StepStatus } from '../../storage/schema.js';

// ---------------------------------------------------------------------------
// Workflow definition (top-level YAML shape)
// ---------------------------------------------------------------------------

/** A declared workflow input — purely informational at the type level. */
export interface WorkflowInput {
  name: string;
  type?: 'string' | 'number' | 'boolean' | 'object';
  description?: string;
  required?: boolean;
  default?: unknown;
}

/** Risk level reused from the storage layer so policy stays consistent. */
export type StepRisk = 'read' | 'write' | 'network' | 'shell' | 'destructive';

export interface RetryPolicy {
  /** Total attempts including the first try. Must be ≥ 1. */
  max_attempts: number;
  /** Initial backoff in milliseconds. */
  backoff_ms: number;
  /** Multiplier applied per failed attempt. Defaults to 1 (linear). */
  multiplier?: number;
}

/** Spec for a worker subagent in the orchestrator-worker topology. */
export interface SubagentSpec {
  /** Stable id used to scope the spawned step in the parent run. */
  id: string;
  /** Registered agent id to spawn. */
  agent: string;
  /** Goal template (supports `${inputs.x}` / `${outputs.id}` interpolation). */
  goal: string;
  model?: string;
  timeout_ms?: number;
}

// --- Step variants ---------------------------------------------------------

export interface AgentStepDef {
  kind: 'agent';
  id: string;
  /** Registered agent id to spawn. */
  agent: string;
  /** Goal template — interpolated against `inputs` and prior step outputs. */
  goal: string;
  model?: string;
  timeout_ms?: number;
  retry?: RetryPolicy;
  /** When set, run as orchestrator-worker (see `orchestrator.ts`). */
  spawn_subagents?: SubagentSpec[];
}

export interface ParallelStepDef {
  kind: 'parallel';
  id: string;
  /**
   * Each entry is an independent branch executed concurrently. The parallel
   * step succeeds only when every branch succeeds.
   */
  branches: StepDef[][];
}

export interface ConditionalStepDef {
  kind: 'conditional';
  id: string;
  /** JS expression evaluated against `{ inputs, outputs }`. */
  when: string;
  then: StepDef[];
  else?: StepDef[];
}

export interface ApprovalStepDef {
  kind: 'approval';
  id: string;
  /** Prompt shown to the human approver. */
  prompt: string;
  risk: StepRisk;
}

export interface WaitEventStepDef {
  kind: 'wait_event';
  id: string;
  /** Filter applied to the `events.kind` column. */
  event_kind: string;
  /** Optional shallow equality filter against the JSON payload. */
  match?: Record<string, unknown>;
  /** If set, the wait gives up after this many milliseconds. */
  timeout_ms?: number;
}

export interface SequenceStepDef {
  kind: 'sequence';
  id: string;
  steps: StepDef[];
}

export type StepDef =
  | AgentStepDef
  | ParallelStepDef
  | ConditionalStepDef
  | ApprovalStepDef
  | WaitEventStepDef
  | SequenceStepDef;

export type StepKindLiteral = StepDef['kind'];

export interface WorkflowDef {
  id: string;
  version: number;
  description?: string;
  inputs?: WorkflowInput[];
  steps: StepDef[];
}

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

/** Why the workflow is paused (set when `status === 'pending'` mid-run). */
export type PauseReason = 'approval' | 'wait_event';

/**
 * Reconstructible runtime state for a workflow run. The executor rebuilds
 * this from the database on resume — nothing here is authoritative in memory.
 */
export interface WorkflowRunState {
  runId: string;
  workflowId: string;
  status: RunStatus;
  /** Step ids (scoped, NOT prefixed with runId) that completed successfully. */
  completedStepIds: Set<string>;
  /** Outputs keyed by scoped step id. */
  outputs: Map<string, unknown>;
  /** Step id the executor is currently working on (if any). */
  currentStepId?: string;
  pausedReason?: PauseReason;
}

// ---------------------------------------------------------------------------
// Streaming events
// ---------------------------------------------------------------------------

interface WorkflowEventBase {
  runId: string;
  timestamp: number;
}

/** Event union streamed by `runWorkflow` / `resumeWorkflow`. */
export type WorkflowEvent =
  | (WorkflowEventBase & {
      type: 'step_started';
      stepId: string;
      kind: StepKindLiteral;
    })
  | (WorkflowEventBase & {
      type: 'step_completed';
      stepId: string;
      kind: StepKindLiteral;
      output?: unknown;
    })
  | (WorkflowEventBase & {
      type: 'step_failed';
      stepId: string;
      kind: StepKindLiteral;
      error: string;
    })
  | (WorkflowEventBase & {
      type: 'step_retrying';
      stepId: string;
      attempt: number;
      nextDelayMs: number;
      error: string;
    })
  | (WorkflowEventBase & {
      type: 'approval_requested';
      stepId: string;
      approvalId: string;
      prompt: string;
      risk: StepRisk;
    })
  | (WorkflowEventBase & {
      type: 'awaiting_event';
      stepId: string;
      eventKind: string;
      match?: Record<string, unknown>;
    })
  | (WorkflowEventBase & {
      type: 'workflow_paused';
      reason: PauseReason;
      stepId: string;
    })
  | (WorkflowEventBase & {
      type: 'workflow_resumed';
      fromStepId?: string;
    })
  | (WorkflowEventBase & {
      type: 'workflow_completed';
    })
  | (WorkflowEventBase & {
      type: 'workflow_failed';
      stepId?: string;
      error: string;
    })
  | (WorkflowEventBase & {
      type: 'workflow_cancelled';
    });

export type WorkflowEventType = WorkflowEvent['type'];

// ---------------------------------------------------------------------------
// Step status re-export so callers don't have to dip into storage internals.
// ---------------------------------------------------------------------------

export type { RunStatus, StepStatus };
