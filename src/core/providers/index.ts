/**
 * Public surface of the provider module (PRD §2.2, Phase 3).
 *
 * Bundle B (claude_code_local adapter) and Bundle C (CLI consumer) import
 * everything they need from here.
 */

import { registerProvider } from './factory.js';

export * from './types.js';
export * from './capabilities.js';
export * from './factory.js';
export { FakeProvider, scriptedTranscript } from './fake.js';
export type { FakeProviderOptions, ScriptedTranscriptBuilder } from './fake.js';

/**
 * Eagerly registers the built-in providers shipped under `src/providers/<id>/`.
 *
 * The import is dynamic and guarded — if the adapter module is missing
 * (Bundle B not yet shipped, or a fake-only test env), the failure is
 * swallowed so the FakeProvider path keeps working. Each adapter module is
 * expected to export a `register(opts)` function that wires its factory via
 * `registerProvider`.
 */
export async function ensureBuiltinProvidersRegistered(
  config: Record<string, unknown> = {},
): Promise<void> {
  await tryRegister('../../providers/claude_code_local/index.js', config);
}

async function tryRegister(modulePath: string, config: Record<string, unknown>): Promise<void> {
  try {
    const mod = (await import(modulePath)) as {
      register?: (
        opts: Record<string, unknown>,
        register: typeof registerProvider,
      ) => void | Promise<void>;
    };
    if (typeof mod.register === 'function') {
      await mod.register(config, registerProvider);
    }
  } catch {
    // Adapter module missing or failed to load — fall back silently. Callers
    // that need a real provider will see UnknownProviderError when they ask
    // for it, which is the clearer error surface.
  }
}
