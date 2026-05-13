import { describe, expect, it } from 'vitest';

import { computeCost } from '../../../src/providers/openai_api/adapter.js';

describe('computeCost', () => {
  it('returns a number for a known model', () => {
    const cost = computeCost({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }, 'gpt-4.1');
    // 1M input * $2 + 1M output * $8 = $10
    expect(cost).toBeCloseTo(10, 5);
  });

  it('returns null for an unknown model', () => {
    expect(
      computeCost({ prompt_tokens: 100, completion_tokens: 100 }, 'gpt-unknown-99'),
    ).toBeNull();
  });

  it('returns null when usage is null or undefined', () => {
    expect(computeCost(null, 'gpt-4.1')).toBeNull();
    expect(computeCost(undefined, 'gpt-4.1')).toBeNull();
  });

  it('treats missing prompt/completion tokens as zero', () => {
    const cost = computeCost({}, 'gpt-4.1');
    expect(cost).toBe(0);
  });
});
