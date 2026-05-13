/**
 * Barrel for the `anthropic_api` provider (PRD §2.2, Phase 11).
 *
 * The `register()` entrypoint wires this adapter into the central provider
 * registry. `ensureBuiltinProvidersRegistered` (in `src/core/providers/`)
 * calls it lazily so the registry stays decoupled from concrete adapters.
 */

import { registerProvider } from '../../core/providers/index.js';

import { AnthropicApiProvider, computeCost, type AnthropicApiProviderOptions } from './adapter.js';

export { AnthropicApiProvider, computeCost };
export type { AnthropicApiProviderOptions };
export type {
  AnthropicContentBlock,
  AnthropicFinalMessage,
  AnthropicLike,
  AnthropicMessageStream,
  AnthropicStreamEvent,
  AnthropicStreamParams,
  AnthropicUsage,
} from './types.js';

/**
 * Register the adapter factory under the `anthropic_api` provider id.
 *
 * The factory receives the per-provider options bag from
 * `agent-os.config.yaml` (PRD §2.5). Adapter-specific keys (`clientFactory`
 * for tests, `defaultModel` to override the default) are picked off; unknown
 * keys are ignored so the config layer can evolve without breaking the adapter.
 */
export function register(opts: AnthropicApiProviderOptions = {}): void {
  registerProvider('anthropic_api', () => new AnthropicApiProvider(opts));
}
