/**
 * Provider registry + factory (PRD §2.2, Phase 3).
 *
 * Adapters register themselves through `registerProvider`. Consumers resolve
 * a `ProviderId` to a concrete `Provider` instance through `getProvider`.
 * The registry holds factories (not instances) so callers can pass per-run
 * options without sharing state across runs.
 *
 * This module deliberately has zero static imports of any concrete adapter —
 * the only coupling is the dynamic `ensureBuiltinProvidersRegistered` helper,
 * which is guarded so the FakeProvider path keeps working when no adapter is
 * shipped (e.g. before Bundle B lands or in test envs).
 */

import type { Provider, ProviderId } from './types.js';

/** Options threaded from the caller to a provider factory. Adapter-specific. */
export type ProviderFactoryOpts = Record<string, unknown> & {
  /** Soft kill-switch — callers may pre-disable a provider via config. */
  enabled?: boolean;
};

/** A factory builds a `Provider` instance for a given options bag. */
export type ProviderFactory = (opts: ProviderFactoryOpts) => Provider;

/** Thrown when `getProvider` is asked for a `ProviderId` no one has registered. */
export class UnknownProviderError extends Error {
  constructor(public readonly id: string) {
    super(`unknown provider id: ${id}`);
    this.name = 'UnknownProviderError';
  }
}

/** Thrown when the caller (or registered factory) declines to build the provider. */
export class ProviderNotEnabledError extends Error {
  constructor(
    public readonly id: ProviderId,
    reason?: string,
  ) {
    super(`provider not enabled: ${id}${reason ? ` (${reason})` : ''}`);
    this.name = 'ProviderNotEnabledError';
  }
}

const registry = new Map<ProviderId, ProviderFactory>();

/** Register (or replace) the factory for a provider id. */
export function registerProvider(id: ProviderId, factory: ProviderFactory): void {
  registry.set(id, factory);
}

/** Forget a registered provider. Primarily a test hook. */
export function unregisterProvider(id: ProviderId): void {
  registry.delete(id);
}

/** True if a factory has been registered for `id`. */
export function hasProvider(id: ProviderId): boolean {
  return registry.has(id);
}

/** Snapshot of registered provider ids — handy for diagnostics. */
export function listRegisteredProviders(): ProviderId[] {
  return [...registry.keys()];
}

/**
 * Build a `Provider` instance for `id`.
 *
 * Throws `UnknownProviderError` for unregistered ids and
 * `ProviderNotEnabledError` when the caller passes `{ enabled: false }`.
 * Adapter factories may throw their own errors when their config is missing;
 * those propagate as-is so the caller can surface them to the user.
 */
export function getProvider(id: ProviderId, opts: ProviderFactoryOpts = {}): Provider {
  const factory = registry.get(id);
  if (factory === undefined) {
    throw new UnknownProviderError(id);
  }
  if (opts.enabled === false) {
    throw new ProviderNotEnabledError(id, 'caller passed { enabled: false }');
  }
  return factory(opts);
}

/** Clears every registration. Test-only escape hatch. */
export function _resetRegistryForTests(): void {
  registry.clear();
}
