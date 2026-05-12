import { z } from 'zod';

/**
 * Risk action enum — how the policy engine should react when a tool of a
 * given risk class is invoked.
 */
export const RiskActionSchema = z.enum(['allow', 'approval_required', 'deny']);
export type RiskAction = z.infer<typeof RiskActionSchema>;

/**
 * Runtime section — top-level execution defaults.
 */
export const RuntimeConfigSchema = z
  .object({
    default_provider: z
      .enum(['claude_code_local', 'anthropic_api', 'openai_api'])
      .default('claude_code_local'),
    storage: z.enum(['local_sqlite']).default('local_sqlite'),
    workspace_root: z.string().default('.'),
    require_approval_for_risky_tools: z.boolean().default(true),
  })
  .strict();
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

/**
 * Provider sub-schemas.
 */
export const ClaudeCodeLocalProviderSchema = z
  .object({
    enabled: z.boolean().default(true),
    requires_api_key: z.boolean().default(false),
    sdk: z.string().default('@anthropic-ai/claude-agent-sdk'),
  })
  .strict();
export type ClaudeCodeLocalProviderConfig = z.infer<typeof ClaudeCodeLocalProviderSchema>;

export const AnthropicApiProviderSchema = z
  .object({
    enabled: z.boolean().default(false),
    api_key_env: z.string().default('ANTHROPIC_API_KEY'),
  })
  .strict();
export type AnthropicApiProviderConfig = z.infer<typeof AnthropicApiProviderSchema>;

export const OpenAiApiProviderSchema = z
  .object({
    enabled: z.boolean().default(false),
    api_key_env: z.string().default('OPENAI_API_KEY'),
  })
  .strict();
export type OpenAiApiProviderConfig = z.infer<typeof OpenAiApiProviderSchema>;

export const ProvidersConfigSchema = z
  .object({
    claude_code_local: ClaudeCodeLocalProviderSchema.default({}),
    anthropic_api: AnthropicApiProviderSchema.default({}),
    openai_api: OpenAiApiProviderSchema.default({}),
  })
  .strict();
export type ProvidersConfig = z.infer<typeof ProvidersConfigSchema>;

/**
 * Security section — tool-policy posture and audit hygiene.
 */
export const RiskLevelsSchema = z
  .object({
    read: RiskActionSchema.default('allow'),
    write: RiskActionSchema.default('approval_required'),
    network: RiskActionSchema.default('approval_required'),
    shell: RiskActionSchema.default('approval_required'),
    destructive: RiskActionSchema.default('deny'),
  })
  .strict();
export type RiskLevels = z.infer<typeof RiskLevelsSchema>;

export const SecurityConfigSchema = z
  .object({
    default_tool_policy: z.enum(['allow', 'deny']).default('deny'),
    risk_levels: RiskLevelsSchema.default({}),
    pinned_mcp_servers: z.boolean().default(true),
    redact_secrets_in_logs: z.boolean().default(true),
  })
  .strict();
export type SecurityConfig = z.infer<typeof SecurityConfigSchema>;

/**
 * Memory section — scoped agent memory.
 */
export const MemoryConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    storage: z.enum(['local']).default('local'),
    semantic_search: z.enum(['enabled', 'disabled', 'optional']).default('optional'),
    default_scopes: z.array(z.string()).default(['project', 'user_preferences']),
  })
  .strict();
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;

/**
 * Observability section.
 */
export const OtlpExporterConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    endpoint: z.string().default(''),
  })
  .strict();
export type OtlpExporterConfig = z.infer<typeof OtlpExporterConfigSchema>;

export const ObservabilityConfigSchema = z
  .object({
    local_logs: z.boolean().default(true),
    traces: z.boolean().default(true),
    otlp_exporter: OtlpExporterConfigSchema.default({}),
  })
  .strict();
export type ObservabilityConfig = z.infer<typeof ObservabilityConfigSchema>;

/**
 * Approvals section.
 *
 * `policies` is the per-scope override map (PRD §3 Phase 6 — "configurable
 * policies per agent, per tool, per workflow"). YAML uses snake_case; the
 * loader downstream (`src/core/approvals/policies.ts`) converts to camelCase
 * for the runtime `ApprovalPolicies` shape.
 */
export const AgentApprovalPolicySchema = z
  .object({
    require_approval_for_tools: z.array(z.string()).default([]),
    ttl_seconds: z.number().int().positive().optional(),
  })
  .strict();
export type AgentApprovalPolicyConfig = z.infer<typeof AgentApprovalPolicySchema>;

export const ToolApprovalPolicySchema = z
  .object({
    require_approval: z.boolean().optional(),
    ttl_seconds: z.number().int().positive().optional(),
  })
  .strict();
export type ToolApprovalPolicyConfig = z.infer<typeof ToolApprovalPolicySchema>;

export const WorkflowApprovalPolicySchema = z
  .object({
    require_approval_for_steps: z.array(z.string()).default([]),
    ttl_seconds: z.number().int().positive().optional(),
  })
  .strict();
export type WorkflowApprovalPolicyConfig = z.infer<typeof WorkflowApprovalPolicySchema>;

export const ApprovalPoliciesConfigSchema = z
  .object({
    per_agent: z.record(z.string(), AgentApprovalPolicySchema).default({}),
    per_tool: z.record(z.string(), ToolApprovalPolicySchema).default({}),
    per_workflow: z.record(z.string(), WorkflowApprovalPolicySchema).default({}),
  })
  .strict()
  .default({});
export type ApprovalPoliciesConfig = z.infer<typeof ApprovalPoliciesConfigSchema>;

export const ApprovalsConfigSchema = z
  .object({
    channels: z.array(z.enum(['cli', 'web', 'slack', 'github'])).default(['cli']),
    default_ttl_minutes: z.number().int().positive().default(60),
    policies: ApprovalPoliciesConfigSchema.default({}),
  })
  .strict();
export type ApprovalsConfig = z.infer<typeof ApprovalsConfigSchema>;

/**
 * Top-level composed config.
 */
export const AgentOsConfigSchema = z
  .object({
    runtime: RuntimeConfigSchema.default({}),
    providers: ProvidersConfigSchema.default({}),
    security: SecurityConfigSchema.default({}),
    memory: MemoryConfigSchema.default({}),
    observability: ObservabilityConfigSchema.default({}),
    approvals: ApprovalsConfigSchema.default({}),
  })
  .strict();
export type AgentOsConfig = z.infer<typeof AgentOsConfigSchema>;
