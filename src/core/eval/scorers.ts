/**
 * Assertion scorers for the Agent OS eval framework.
 *
 * Three families per PRD Phase 9:
 *   - deterministic: `regex`, `contains*`, `icontains*`, `is-json`
 *   - programmatic:  `javascript`
 *   - model-graded:  `llm-rubric` (cleanly skipped when no API provider is configured)
 *
 * Semantics:
 *   - `negate` is applied AFTER computing pass/fail, but skipped+negate is still skipped.
 *   - A missing required `value` returns `{passed:false, skipped:false, reason:'missing value'}`.
 *   - `weight` defaults to 1 and is echoed back on the result so the case-level
 *     reducer can compute a deterministic weighted score.
 */

import type { Assertion, AssertionResult } from './types.js';

export interface LlmRubricGrader {
  (args: {
    output: string;
    rubric: string;
    provider?: string;
  }): Promise<{ passed: boolean; reason?: string }>;
}

export interface ScoreContext {
  /** Variables from the test case, available to the `javascript` scorer. */
  vars: Record<string, string>;
  /**
   * Grader for `llm-rubric` assertions. When `null`, those assertions are
   * cleanly skipped — preserving the PRD's "works locally with no API key"
   * invariant.
   */
  llmRubricGrader: LlmRubricGrader | null;
}

/** Internal raw outcome shape — converted to an `AssertionResult` below. */
interface RawOutcome {
  passed: boolean;
  skipped: boolean;
  reason?: string;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  if (!v.every((x) => typeof x === 'string')) return null;
  return v as string[];
}

function missingValue(): RawOutcome {
  return { passed: false, skipped: false, reason: 'missing value' };
}

function badValue(reason: string): RawOutcome {
  return { passed: false, skipped: false, reason };
}

function runJavascript(value: string, output: string, context: ScoreContext): RawOutcome {
  // Promptfoo supports both expression form and function-body form. If the
  // user wrote an explicit `return`, treat the value as a function body;
  // otherwise wrap it as a single returned expression.
  const usesReturn = /\breturn\b/.test(value);
  const body = usesReturn ? value : `return (${value});`;
  let fn: (output: string, context: { vars: Record<string, string> }) => unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    fn = new Function('output', 'context', body) as typeof fn;
  } catch (err) {
    return {
      passed: false,
      skipped: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  try {
    const result = fn(output, { vars: context.vars });
    return { passed: Boolean(result), skipped: false };
  } catch (err) {
    return {
      passed: false,
      skipped: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

async function computeOutcome(
  a: Assertion,
  output: string,
  ctx: ScoreContext,
): Promise<RawOutcome> {
  switch (a.type) {
    case 'regex': {
      const v = asString(a.value);
      if (v === null)
        return a.value === undefined ? missingValue() : badValue('value must be a string');
      let re: RegExp;
      try {
        re = new RegExp(v);
      } catch (err) {
        return badValue(err instanceof Error ? err.message : String(err));
      }
      return { passed: re.test(output), skipped: false };
    }

    case 'contains': {
      const v = asString(a.value);
      if (v === null)
        return a.value === undefined ? missingValue() : badValue('value must be a string');
      return { passed: output.includes(v), skipped: false };
    }

    case 'contains-any': {
      const v = asStringArray(a.value);
      if (v === null)
        return a.value === undefined ? missingValue() : badValue('value must be a string[]');
      return { passed: v.some((needle) => output.includes(needle)), skipped: false };
    }

    case 'contains-all': {
      const v = asStringArray(a.value);
      if (v === null)
        return a.value === undefined ? missingValue() : badValue('value must be a string[]');
      return { passed: v.every((needle) => output.includes(needle)), skipped: false };
    }

    case 'icontains': {
      const v = asString(a.value);
      if (v === null)
        return a.value === undefined ? missingValue() : badValue('value must be a string');
      return { passed: output.toLowerCase().includes(v.toLowerCase()), skipped: false };
    }

    case 'icontains-any': {
      const v = asStringArray(a.value);
      if (v === null)
        return a.value === undefined ? missingValue() : badValue('value must be a string[]');
      const lower = output.toLowerCase();
      return { passed: v.some((needle) => lower.includes(needle.toLowerCase())), skipped: false };
    }

    case 'is-json': {
      try {
        JSON.parse(output);
        return { passed: true, skipped: false };
      } catch (err) {
        return {
          passed: false,
          skipped: false,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    }

    case 'javascript': {
      const v = asString(a.value);
      if (v === null)
        return a.value === undefined ? missingValue() : badValue('value must be a string');
      return runJavascript(v, output, ctx);
    }

    case 'llm-rubric': {
      const v = asString(a.value);
      if (v === null)
        return a.value === undefined ? missingValue() : badValue('value must be a string');
      if (ctx.llmRubricGrader === null) {
        return { passed: true, skipped: true, reason: 'no API provider configured' };
      }
      try {
        const verdict = await ctx.llmRubricGrader({
          output,
          rubric: v,
          provider: a.provider,
        });
        return { passed: verdict.passed, skipped: false, reason: verdict.reason };
      } catch (err) {
        return {
          passed: false,
          skipped: false,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    }

    default: {
      // Defence-in-depth: loader should have caught this.
      const exhaustive: never = a.type;
      throw new Error(`unknown assertion type: ${String(exhaustive)}`);
    }
  }
}

/**
 * Evaluate a single assertion against the agent's output, returning a
 * structured `AssertionResult`. Applies `negate` only to non-skipped outcomes.
 */
export async function evaluateAssertion(
  a: Assertion,
  output: string,
  ctx: ScoreContext,
): Promise<AssertionResult> {
  const raw = await computeOutcome(a, output, ctx);
  const weight = a.weight ?? 1;

  // Skipped outcomes pass through untouched — negation is meaningless without
  // a real signal, and we want the case to remain effectively "scored as 1"
  // for the skipped weight.
  if (raw.skipped) {
    return {
      type: a.type,
      passed: raw.passed,
      skipped: true,
      reason: raw.reason,
      weight,
    };
  }

  const passed = a.negate ? !raw.passed : raw.passed;
  return {
    type: a.type,
    passed,
    skipped: false,
    reason: raw.reason,
    weight,
  };
}
