/**
 * Barrel for the `claude_code_local` provider (PRD §2.2, Phase 3).
 *
 * The `register()` entrypoint wires this adapter into the central provider
 * registry. `ensureBuiltinProvidersRegistered` (in `src/core/providers/`)
 * calls it lazily so the registry stays decoupled from concrete adapters.
 */

import { registerProvider } from '../../core/providers/index.js';

import {
  ClaudeCodeLocalProvider,
  mapSdkEvent,
  newAssistantBuffer,
  flushAssistantBuffer,
  type AssistantBuffer,
  type ClaudeCodeLocalProviderOptions,
} from './adapter.js';
import { loadMcpServers } from './mcp.js';

export {
  ClaudeCodeLocalProvider,
  mapSdkEvent,
  newAssistantBuffer,
  flushAssistantBuffer,
  loadMcpServers,
};
export type { AssistantBuffer, ClaudeCodeLocalProviderOptions };

/**
 * Register the adapter factory under the `claude_code_local` provider id.
 *
 * The factory receives the per-provider options bag from
 * `agent-os.config.yaml` (PRD §2.5). Adapter-specific keys (today just
 * `sdkImport` for tests) are picked off; unknown keys are ignored so the
 * config layer can evolve without breaking the adapter.
 */
export function register(opts: ClaudeCodeLocalProviderOptions = {}): void {
  registerProvider('claude_code_local', () => new ClaudeCodeLocalProvider(opts));
}
