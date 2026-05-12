import { describe, expect, it } from 'vitest';

import { evaluateAssertion, type ScoreContext } from '../../../src/core/eval/scorers.js';
import type { Assertion } from '../../../src/core/eval/types.js';

function ctx(over: Partial<ScoreContext> = {}): ScoreContext {
  return {
    vars: over.vars ?? {},
    llmRubricGrader: over.llmRubricGrader ?? null,
  };
}

describe('regex', () => {
  it('passes when the pattern matches', async () => {
    const a: Assertion = { type: 'regex', value: 'foo\\d+' };
    const r = await evaluateAssertion(a, 'see foo42 here', ctx());
    expect(r.passed).toBe(true);
    expect(r.skipped).toBe(false);
  });

  it('fails when the pattern does not match', async () => {
    const a: Assertion = { type: 'regex', value: '^bar$' };
    const r = await evaluateAssertion(a, 'foo', ctx());
    expect(r.passed).toBe(false);
  });

  it('respects negate', async () => {
    const a: Assertion = { type: 'regex', value: 'never', negate: true };
    const r = await evaluateAssertion(a, 'absolutely not present', ctx());
    expect(r.passed).toBe(true);
  });

  it('reports missing value', async () => {
    const a: Assertion = { type: 'regex' };
    const r = await evaluateAssertion(a, 'x', ctx());
    expect(r.passed).toBe(false);
    expect(r.reason).toBe('missing value');
  });
});

describe('contains / contains-any / contains-all', () => {
  it('contains is case-sensitive', async () => {
    expect(
      (await evaluateAssertion({ type: 'contains', value: 'Hello' }, 'Hello world', ctx())).passed,
    ).toBe(true);
    expect(
      (await evaluateAssertion({ type: 'contains', value: 'hello' }, 'Hello world', ctx())).passed,
    ).toBe(false);
  });

  it('contains-any passes if any needle matches', async () => {
    const a: Assertion = { type: 'contains-any', value: ['nope', 'world'] };
    expect((await evaluateAssertion(a, 'Hello world', ctx())).passed).toBe(true);
  });

  it('contains-all requires every needle', async () => {
    const a: Assertion = { type: 'contains-all', value: ['Hello', 'world'] };
    expect((await evaluateAssertion(a, 'Hello world', ctx())).passed).toBe(true);
    expect(
      (
        await evaluateAssertion(
          { type: 'contains-all', value: ['Hello', 'missing'] },
          'Hello world',
          ctx(),
        )
      ).passed,
    ).toBe(false);
  });

  it('contains-all reports a string[] value requirement', async () => {
    const a: Assertion = { type: 'contains-all', value: 'oops' };
    const r = await evaluateAssertion(a, 'x', ctx());
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/string/);
  });
});

describe('icontains / icontains-any', () => {
  it('icontains is case-insensitive', async () => {
    const a: Assertion = { type: 'icontains', value: 'hello' };
    expect((await evaluateAssertion(a, 'HELLO world', ctx())).passed).toBe(true);
  });

  it('icontains-any matches case-insensitively', async () => {
    const a: Assertion = { type: 'icontains-any', value: ['NOPE', 'World'] };
    expect((await evaluateAssertion(a, 'hello world', ctx())).passed).toBe(true);
  });
});

describe('is-json', () => {
  it('passes for parseable JSON', async () => {
    const r = await evaluateAssertion({ type: 'is-json' }, '{"a":1}', ctx());
    expect(r.passed).toBe(true);
  });

  it('fails for unparseable JSON', async () => {
    const r = await evaluateAssertion({ type: 'is-json' }, 'not json', ctx());
    expect(r.passed).toBe(false);
    expect(r.reason).toBeDefined();
  });

  it('respects negate', async () => {
    const r = await evaluateAssertion({ type: 'is-json', negate: true }, 'not json', ctx());
    expect(r.passed).toBe(true);
  });
});

describe('javascript', () => {
  it('evaluates expression form (truthy = pass)', async () => {
    const a: Assertion = { type: 'javascript', value: 'output.length > 0' };
    expect((await evaluateAssertion(a, 'hi', ctx())).passed).toBe(true);
    expect((await evaluateAssertion(a, '', ctx())).passed).toBe(false);
  });

  it('evaluates return-body form', async () => {
    const a: Assertion = {
      type: 'javascript',
      value: 'const n = output.length; return n >= 3;',
    };
    expect((await evaluateAssertion(a, 'hey', ctx())).passed).toBe(true);
    expect((await evaluateAssertion(a, 'hi', ctx())).passed).toBe(false);
  });

  it('exposes context.vars to the snippet', async () => {
    const a: Assertion = {
      type: 'javascript',
      value: 'return output.includes(context.vars.needle);',
    };
    const r = await evaluateAssertion(a, 'apple pie', ctx({ vars: { needle: 'pie' } }));
    expect(r.passed).toBe(true);
  });

  it('reports thrown errors as failure', async () => {
    const a: Assertion = {
      type: 'javascript',
      value: 'return (function(){ throw new Error("boom"); })();',
    };
    const r = await evaluateAssertion(a, 'x', ctx());
    expect(r.passed).toBe(false);
    expect(r.reason).toContain('boom');
  });

  it('reports syntax errors as failure', async () => {
    const a: Assertion = { type: 'javascript', value: 'this is not js!!!' };
    const r = await evaluateAssertion(a, 'x', ctx());
    expect(r.passed).toBe(false);
    expect(r.reason).toBeDefined();
  });

  it('supports negate', async () => {
    const a: Assertion = {
      type: 'javascript',
      value: 'output.length > 100',
      negate: true,
    };
    expect((await evaluateAssertion(a, 'short', ctx())).passed).toBe(true);
  });
});

describe('llm-rubric', () => {
  it('skips cleanly when no grader is configured', async () => {
    const a: Assertion = { type: 'llm-rubric', value: 'rubric text' };
    const r = await evaluateAssertion(a, 'output', ctx({ llmRubricGrader: null }));
    expect(r.skipped).toBe(true);
    expect(r.passed).toBe(true);
    expect(r.reason).toMatch(/no API provider/);
  });

  it('delegates to the grader when present', async () => {
    const a: Assertion = { type: 'llm-rubric', value: 'rubric', provider: 'anthropic:foo' };
    const r = await evaluateAssertion(
      a,
      'good output',
      ctx({
        llmRubricGrader: async ({ rubric, provider }) => ({
          passed: rubric === 'rubric' && provider === 'anthropic:foo',
          reason: 'matched',
        }),
      }),
    );
    expect(r.passed).toBe(true);
    expect(r.skipped).toBe(false);
    expect(r.reason).toBe('matched');
  });

  it('treats grader rejections as failure', async () => {
    const a: Assertion = { type: 'llm-rubric', value: 'rubric' };
    const r = await evaluateAssertion(
      a,
      'x',
      ctx({
        llmRubricGrader: async () => {
          throw new Error('rate limited');
        },
      }),
    );
    expect(r.passed).toBe(false);
    expect(r.reason).toContain('rate limited');
  });

  it('does NOT invert skipped results with negate', async () => {
    const a: Assertion = { type: 'llm-rubric', value: 'rubric', negate: true };
    const r = await evaluateAssertion(a, 'output', ctx({ llmRubricGrader: null }));
    expect(r.skipped).toBe(true);
    expect(r.passed).toBe(true);
  });
});

describe('weight', () => {
  it('defaults to 1 and echoes back the configured weight', async () => {
    const r1 = await evaluateAssertion({ type: 'contains', value: 'x' }, 'x', ctx());
    expect(r1.weight).toBe(1);
    const r2 = await evaluateAssertion({ type: 'contains', value: 'x', weight: 3 }, 'x', ctx());
    expect(r2.weight).toBe(3);
  });
});
