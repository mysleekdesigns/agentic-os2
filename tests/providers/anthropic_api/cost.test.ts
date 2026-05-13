import { describe, expect, it } from 'vitest';

import { computeCost } from '../../../src/providers/anthropic_api/index.js';

describe('computeCost', () => {
  it('returns null for unknown models', () => {
    expect(
      computeCost({ input_tokens: 1000, output_tokens: 500 }, 'never-shipped-9000'),
    ).toBeNull();
  });

  it('returns null when usage is missing', () => {
    expect(computeCost(undefined, 'claude-sonnet-4-6')).toBeNull();
  });

  it('returns a positive number for a known model', () => {
    const cost = computeCost(
      { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      'claude-sonnet-4-6',
    );
    // sonnet rates: $3/MTok input, $15/MTok output → 1M+1M = $18.
    expect(cost).toBe(18);
  });

  it('includes cache_creation tokens at the input rate', () => {
    const cost = computeCost(
      {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 1_000_000,
      },
      'claude-sonnet-4-6',
    );
    expect(cost).toBe(3);
  });

  it('charges cache_read tokens at 10% of the input rate', () => {
    const cost = computeCost(
      {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 1_000_000,
      },
      'claude-sonnet-4-6',
    );
    // 10% of $3 = $0.30
    expect(cost).toBeCloseTo(0.3, 6);
  });

  it('prices opus and haiku from the static table', () => {
    expect(computeCost({ input_tokens: 1_000_000, output_tokens: 0 }, 'claude-opus-4-7')).toBe(15);
    expect(
      computeCost({ input_tokens: 1_000_000, output_tokens: 0 }, 'claude-haiku-4-5-20251001'),
    ).toBeCloseTo(0.8, 6);
  });
});
