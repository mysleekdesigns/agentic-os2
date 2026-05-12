/**
 * Zod schemas for workflow definitions (PRD §3 Phase 5).
 *
 * Mirrors the TypeScript types in `types.ts`. The recursive `StepDef` shape is
 * expressed via `z.lazy(...)` so the discriminated union can refer to itself
 * (parallel / conditional / sequence each carry nested steps).
 *
 * Canonical entry point: `parseWorkflowDef(raw)`.
 */

import { z, ZodError } from 'zod';

import type { StepDef, WorkflowDef } from './types.js';

// Slug constraint matches the agent id regex so workflow ids are filesystem-
// safe and stable as DB keys.
const WorkflowIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, {
  message: 'id must be 1-64 chars of [a-z0-9_-], starting with [a-z0-9]',
});

const StepIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, {
  message: 'step id must be 1-64 chars of [a-z0-9_-], starting with [a-z0-9]',
});

export const RiskSchema = z.enum(['read', 'write', 'network', 'shell', 'destructive']);

export const RetryPolicySchema = z.object({
  max_attempts: z.number().int().min(1),
  backoff_ms: z.number().int().min(0),
  multiplier: z.number().positive().optional(),
});

export const SubagentSpecSchema = z.object({
  id: StepIdSchema,
  agent: z.string().min(1),
  goal: z.string().min(1),
  model: z.string().min(1).optional(),
  timeout_ms: z.number().int().positive().optional(),
});

const AgentStepSchema = z.object({
  kind: z.literal('agent'),
  id: StepIdSchema,
  agent: z.string().min(1),
  goal: z.string().min(1),
  model: z.string().min(1).optional(),
  timeout_ms: z.number().int().positive().optional(),
  retry: RetryPolicySchema.optional(),
  spawn_subagents: z.array(SubagentSpecSchema).min(1).optional(),
});

const ApprovalStepSchema = z.object({
  kind: z.literal('approval'),
  id: StepIdSchema,
  prompt: z.string().min(1),
  risk: RiskSchema,
});

const WaitEventStepSchema = z.object({
  kind: z.literal('wait_event'),
  id: StepIdSchema,
  event_kind: z.string().min(1),
  match: z.record(z.unknown()).optional(),
  timeout_ms: z.number().int().positive().optional(),
});

// The recursive variants reference the union via `z.lazy` to avoid the
// classic "used before defined" hazard. Cast goes through `unknown` so the
// generic recursive type narrows cleanly for callers.
export const StepDefSchema: z.ZodType<StepDef> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    AgentStepSchema,
    ApprovalStepSchema,
    WaitEventStepSchema,
    z.object({
      kind: z.literal('parallel'),
      id: StepIdSchema,
      branches: z.array(z.array(StepDefSchema).min(1)).min(1),
    }),
    z.object({
      kind: z.literal('conditional'),
      id: StepIdSchema,
      when: z.string().min(1),
      then: z.array(StepDefSchema).min(1),
      else: z.array(StepDefSchema).min(1).optional(),
    }),
    z.object({
      kind: z.literal('sequence'),
      id: StepIdSchema,
      steps: z.array(StepDefSchema).min(1),
    }),
  ]),
) as z.ZodType<StepDef>;

export const WorkflowInputSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['string', 'number', 'boolean', 'object']).optional(),
  description: z.string().optional(),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
});

export const WorkflowDefSchema = z.object({
  id: WorkflowIdSchema,
  version: z.number().int().positive(),
  description: z.string().optional(),
  inputs: z.array(WorkflowInputSchema).optional(),
  steps: z.array(StepDefSchema).min(1),
});

/** Thrown by `parseWorkflowDef` on invalid input. */
export class WorkflowParseError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'WorkflowParseError';
  }
}

/**
 * Validate an arbitrary value and return a typed `WorkflowDef`. Also enforces
 * a uniqueness invariant on step ids within a single workflow — duplicates
 * would otherwise collide on the `${runId}:${stepId}` primary key.
 */
export function parseWorkflowDef(raw: unknown): WorkflowDef {
  let parsed: WorkflowDef;
  try {
    parsed = WorkflowDefSchema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      const summary = err.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ');
      throw new WorkflowParseError(`workflow validation failed: ${summary}`, err);
    }
    throw err;
  }

  assertUniqueStepIds(parsed);
  return parsed;
}

/**
 * Walks the nested step tree and throws if any step id is reused. Step ids
 * must be globally unique within a workflow so the deterministic
 * `${runId}:${stepId}` primary key never collides.
 */
function assertUniqueStepIds(def: WorkflowDef): void {
  const seen = new Set<string>();
  const walk = (steps: StepDef[]): void => {
    for (const step of steps) {
      if (seen.has(step.id)) {
        throw new WorkflowParseError(`duplicate step id "${step.id}" in workflow "${def.id}"`);
      }
      seen.add(step.id);
      switch (step.kind) {
        case 'parallel':
          for (const branch of step.branches) walk(branch);
          break;
        case 'conditional':
          walk(step.then);
          if (step.else) walk(step.else);
          break;
        case 'sequence':
          walk(step.steps);
          break;
        case 'agent':
          if (step.spawn_subagents) {
            for (const sub of step.spawn_subagents) {
              if (seen.has(sub.id)) {
                throw new WorkflowParseError(
                  `duplicate step id "${sub.id}" in workflow "${def.id}" (subagent)`,
                );
              }
              seen.add(sub.id);
            }
          }
          break;
        default:
          break;
      }
    }
  };
  walk(def.steps);
}
