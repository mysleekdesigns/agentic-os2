/**
 * Barrel for the `openai_api` provider (PRD §2.2, Phase 11).
 *
 * The `register()` entrypoint wires this adapter into the central provider
 * registry. `ensureBuiltinProvidersRegistered` (in `src/core/providers/`)
 * is expected to call it lazily once the orchestrator wires it in.
 */

import { registerProvider } from '../../core/providers/index.js';

import {
  OpenAiApiProvider,
  computeCost,
  mapTools,
  type OpenAiApiProviderOptions,
  type OpenAiLike,
} from './adapter.js';

export { OpenAiApiProvider, computeCost, mapTools };
export type { OpenAiApiProviderOptions, OpenAiLike };

/**
 * Register the adapter factory under the `openai_api` provider id.
 *
 * The factory receives the per-provider options bag from
 * `agent-os.config.yaml` (PRD §2.5). Adapter-specific keys (`clientFactory`,
 * `defaultModel`) are picked off; unknown keys are ignored.
 */
export function register(opts: OpenAiApiProviderOptions = {}): void {
  registerProvider('openai_api', () => new OpenAiApiProvider(opts));
}
