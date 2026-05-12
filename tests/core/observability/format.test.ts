/**
 * `formatNullableNumber` renderer (PRD §3 Phase 8).
 *
 * Targeted assertions for the helper used by the CLI `show` command to
 * render nullable cost/token columns. The helper lives in
 * `src/core/observability/index.ts` and is exported from the barrel.
 *
 * Contract:
 *  - `null` / `undefined` / `NaN` → `"—"` (em-dash). Zero is NOT collapsed
 *    to a dash; `0` is a real value.
 *  - When `fractionDigits` is provided AND the value is a non-integer,
 *    `value.toFixed(digits)` is applied. Integers are formatted with
 *    `String(value)` so we don't fabricate trailing zeros.
 *  - When `unit` is provided, the numeric formatting is suffixed with
 *    `${formatted} ${unit}` (single space). The helper does NOT prepend a
 *    currency symbol — that is the caller's responsibility (see
 *    `src/cli/commands/show.ts` which wraps with a `$` for `cost_usd`).
 */

import { describe, expect, it } from 'vitest';

import { formatNullableNumber } from '../../../src/core/observability/index.js';

describe('formatNullableNumber', () => {
  it('renders null as the em-dash', () => {
    expect(formatNullableNumber(null)).toBe('—');
  });

  it('renders undefined as the em-dash', () => {
    expect(formatNullableNumber(undefined)).toBe('—');
  });

  it('renders NaN as the em-dash', () => {
    expect(formatNullableNumber(Number.NaN)).toBe('—');
  });

  it('renders zero as "0" (NOT the em-dash — zero is a real value)', () => {
    expect(formatNullableNumber(0)).toBe('0');
  });

  it('renders integers without trailing zeros even when fractionDigits is set', () => {
    expect(formatNullableNumber(7, { fractionDigits: 4 })).toBe('7');
  });

  it('applies fractionDigits to non-integer values via toFixed', () => {
    expect(formatNullableNumber(0.0123, { fractionDigits: 4 })).toBe('0.0123');
    expect(formatNullableNumber(1.5, { fractionDigits: 2 })).toBe('1.50');
  });

  it('appends the unit with a single space (USD suffix shape)', () => {
    expect(formatNullableNumber(1234.56, { fractionDigits: 2, unit: 'USD' })).toBe('1234.56 USD');
  });

  it('appends the unit with a single space (tokens suffix shape, integer value)', () => {
    expect(formatNullableNumber(1234, { unit: 'tokens' })).toBe('1234 tokens');
  });

  it('returns "—" with no unit suffix when the value is null and a unit is provided', () => {
    // Dashes don't carry a unit — column alignment is the caller's problem,
    // but the helper must not fabricate "— USD".
    expect(formatNullableNumber(null, { unit: 'USD' })).toBe('—');
    expect(formatNullableNumber(undefined, { unit: 'tokens' })).toBe('—');
  });
});
