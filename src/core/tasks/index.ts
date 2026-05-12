/**
 * Public surface for the workflow engine (PRD §3 Phase 5).
 *
 * Downstream consumers — the CLI, slash commands, evals — should import only
 * from this module so we can refactor internals without churning callers.
 */

export * from './types.js';
export {
  WorkflowDefSchema,
  StepDefSchema,
  WorkflowInputSchema,
  RetryPolicySchema,
  SubagentSpecSchema,
  RiskSchema,
  parseWorkflowDef,
  WorkflowParseError,
} from './schema.js';
export { loadWorkflow, loadWorkflows, WorkflowLoadError } from './loader.js';
export type { WorkflowDefinition } from './loader.js';
export {
  runWorkflow,
  resumeWorkflow,
  cancelWorkflow,
  interpolate,
  evaluateExpression,
  scopedStepId,
} from './executor.js';
export type {
  ProviderAdapter,
  ProviderAdapterInput,
  ApprovalResolver,
  ApprovalResolverInput,
  RunWorkflowOptions,
  ResumeWorkflowOptions,
  CancelWorkflowOptions,
} from './executor.js';
export { spawnWorkers } from './orchestrator.js';
export type { WorkerResult, SpawnWorkersOptions } from './orchestrator.js';
