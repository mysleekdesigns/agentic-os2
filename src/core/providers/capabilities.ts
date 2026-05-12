/**
 * Honest default capability matrix per provider (PRD §2.2).
 *
 * Adapters are free to override these at construction time — e.g. an
 * `anthropic_api` instance pointed at a model that lacks vision should flip
 * `vision` to false. The defaults represent what the backend can do in
 * principle, not what every model under it supports.
 */

import type { Capabilities, ProviderId } from './types.js';

/** Returns the honest default capabilities for a given provider id. */
export function defaultCapabilitiesFor(id: ProviderId): Capabilities {
  switch (id) {
    case 'claude_code_local':
      return {
        streaming: true,
        tools: true,
        // Local harness wires `.mcp.json` through the Claude Agent SDK.
        mcp: true,
        vision: true,
        // Max plan has no per-call token metering exposed to the SDK.
        costMetering: false,
        promptCaching: false,
      };
    case 'anthropic_api':
      return {
        streaming: true,
        tools: true,
        // OS-level `.mcp.json` does not pass through the raw Messages API (Phase 11 may revise).
        mcp: false,
        vision: true,
        costMetering: true,
        promptCaching: true,
      };
    case 'openai_api':
      return {
        streaming: true,
        tools: true,
        // OS-level `.mcp.json` does not pass through the OpenAI API (Phase 11 may revise).
        mcp: false,
        vision: true,
        costMetering: true,
        promptCaching: false,
      };
    default: {
      const _exhaustive: never = id;
      throw new Error(`defaultCapabilitiesFor: unknown provider id ${String(_exhaustive)}`);
    }
  }
}
