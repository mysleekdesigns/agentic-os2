import { afterEach, describe, expect, it } from 'vitest';

import { defaultCapabilitiesFor } from '../../../src/core/providers/capabilities.js';
import {
  _resetRegistryForTests,
  ProviderNotEnabledError,
  UnknownProviderError,
  ensureBuiltinProvidersRegistered,
  getProvider,
  hasProvider,
  listRegisteredProviders,
  registerProvider,
  unregisterProvider,
} from '../../../src/core/providers/index.js';
import { FakeProvider } from '../../../src/core/providers/fake.js';

afterEach(() => {
  _resetRegistryForTests();
});

describe('provider factory', () => {
  it('round-trips a registered factory through getProvider', () => {
    registerProvider('claude_code_local', () => new FakeProvider({ events: [] }));
    expect(hasProvider('claude_code_local')).toBe(true);
    expect(listRegisteredProviders()).toContain('claude_code_local');

    const provider = getProvider('claude_code_local');
    expect(provider.id).toBe('claude_code_local');
    expect(provider.capabilities).toMatchObject(defaultCapabilitiesFor('claude_code_local'));
  });

  it('unregisterProvider removes the entry', () => {
    registerProvider('anthropic_api', () => new FakeProvider({ events: [] }));
    expect(hasProvider('anthropic_api')).toBe(true);
    unregisterProvider('anthropic_api');
    expect(hasProvider('anthropic_api')).toBe(false);
  });

  it('throws UnknownProviderError for an unregistered id', () => {
    expect(() => getProvider('openai_api')).toThrow(UnknownProviderError);
  });

  it('throws ProviderNotEnabledError when caller passes { enabled: false }', () => {
    registerProvider('anthropic_api', () => new FakeProvider({ events: [] }));
    expect(() => getProvider('anthropic_api', { enabled: false })).toThrow(ProviderNotEnabledError);
  });

  it('propagates errors thrown by the registered factory', () => {
    registerProvider('anthropic_api', () => {
      throw new Error('missing ANTHROPIC_API_KEY');
    });
    expect(() => getProvider('anthropic_api')).toThrow(/missing ANTHROPIC_API_KEY/);
  });

  it('ensureBuiltinProvidersRegistered wires the claude_code_local adapter', async () => {
    // Bundle B ships the adapter under src/providers/claude_code_local/; its
    // register() function should be picked up here and populate the registry.
    await expect(ensureBuiltinProvidersRegistered()).resolves.toBeUndefined();
    expect(hasProvider('claude_code_local')).toBe(true);
  });
});
