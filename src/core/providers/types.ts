/**
 * Provider contract types (PRD §2.2).
 *
 * A `Provider` is the seam that separates orchestration (Agent OS) from
 * execution (a specific model/agent backend). All providers expose the same
 * `run(input): AsyncIterable<RunEvent>` shape so the CLI, scheduler, and
 * evals can stay backend-agnostic.
 *
 * This file holds only types — no runtime logic. Factory and helpers live in
 * `factory.ts` and `capabilities.ts`.
 */

/** Stable identifier for each supported backend (PRD §2.2). */
export type ProviderId = 'claude_code_local' | 'anthropic_api' | 'openai_api';

/**
 * Honest capability matrix for a provider instance. Used by the orchestrator
 * to decide whether to even attempt features like cost metering or MCP
 * passthrough. See `defaultCapabilitiesFor` in `capabilities.ts`.
 */
export interface Capabilities {
  streaming: boolean;
  tools: boolean;
  mcp: boolean;
  vision: boolean;
  /** false for `claude_code_local` — Max plan exposes no token metering. */
  costMetering: boolean;
  promptCaching: boolean;
}

/** Shape of an entry in `.mcp.json` passed through to a provider (PRD §2.7). */
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Inputs required to run an agent through any provider. The provider is
 * responsible for translating this into its native call (SDK, HTTP, etc).
 */
export interface AgentRunInput {
  agentId: string;
  goal: string;
  /** The agent's markdown body — the system instructions. */
  instructions: string;
  model?: string;
  mcpServers?: Record<string, McpServerConfig>;
  allowedTools?: string[];
  approvalRequiredTools?: string[];
  workspaceRoot: string;
  cwd?: string;
  signal?: AbortSignal;
}

/**
 * Discriminated union of events emitted during a run. Consumers MUST handle
 * every variant — exhaustiveness is enforced at compile time via the
 * type-level test in `tests/core/providers/types.test.ts`.
 *
 * `cost` and `tokens` on the `done` event are nullable because the
 * `claude_code_local` backend (Max plan) does not expose token usage.
 */
export type RunEvent =
  | { type: 'message'; role: 'assistant' | 'user'; text: string; timestamp: number }
  | { type: 'tool_call'; toolCallId: string; tool: string; args: unknown; timestamp: number }
  | {
      type: 'tool_result';
      toolCallId: string;
      result: unknown;
      isError?: boolean;
      timestamp: number;
    }
  | {
      type: 'approval_requested';
      toolCallId: string;
      tool: string;
      args: unknown;
      reason?: string;
      timestamp: number;
    }
  | { type: 'error'; message: string; recoverable?: boolean; timestamp: number }
  | {
      type: 'done';
      reason: 'completed' | 'cancelled' | 'error';
      cost: number | null;
      tokens: { input: number | null; output: number | null } | null;
      durationMs: number;
      timestamp: number;
    };

/** Backend-agnostic execution surface (PRD §2.2). */
export interface Provider {
  readonly id: ProviderId;
  readonly capabilities: Capabilities;
  run(input: AgentRunInput): AsyncIterable<RunEvent>;
}
