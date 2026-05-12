/**
 * Pure runner for the Agent OS eval framework.
 *
 * The runner does NOT know how to invoke an agent — callers pass a
 * `RunAgentFn` so this library stays decoupled from the provider/runtime
 * layer. The CLI bundle (`phase9-cli`) wires the agent runtime in.
 *
 * Determinism: fixtures are run in sorted order and cases/prompts are run
 * sequentially. This keeps `EvalRunReport` byte-stable across re-runs of the
 * same scripted `RunAgentFn`, which is the basis for regression diffing.
 */

import { randomUUID } from 'node:crypto';
import { relative, resolve, sep } from 'node:path';

import { discoverFixtures, loadFixtureFile } from './loader.js';
import { evaluateAssertion, type LlmRubricGrader } from './scorers.js';
import type { AssertionResult, EvalRunReport, FixtureResult, TestCaseResult } from './types.js';

export interface RunAgentFn {
  (input: { agentId: string; prompt: string; vars: Record<string, string> }): Promise<string>;
}

export interface EvalRunnerOptions {
  runAgent: RunAgentFn;
  /** Optional grader for `llm-rubric` assertions. Null/undefined => skip them cleanly. */
  llmRubricGrader?: LlmRubricGrader | null;
}

function resolveAgentId(providerId: string): string {
  return providerId.startsWith('agent-os:') ? providerId.slice('agent-os:'.length) : providerId;
}

function toForwardSlash(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

/**
 * Compute the case's pass/fail and weighted score.
 *
 * Skipped assertions count as a passing weight so absent model-graded checks
 * do not penalise the score; they are however excluded from the boolean
 * `passed` calculation only in the sense that they cannot fail it (a skipped
 * assertion has `passed: true` set by the scorer).
 */
function reduceCase(assertions: AssertionResult[]): { passed: boolean; score: number } {
  if (assertions.length === 0) return { passed: true, score: 1 };
  let totalWeight = 0;
  let earned = 0;
  let passed = true;
  for (const r of assertions) {
    totalWeight += r.weight;
    if (r.passed) earned += r.weight;
    if (!r.skipped && !r.passed) passed = false;
  }
  const score = totalWeight === 0 ? 1 : earned / totalWeight;
  return { passed, score };
}

/**
 * Run every test case × prompt combination in a single fixture file.
 */
export async function runFixture(
  filePath: string,
  opts: EvalRunnerOptions,
): Promise<FixtureResult> {
  const abs = resolve(filePath);
  const start = Date.now();
  const fixture = await loadFixtureFile(abs);

  const provider = fixture.providers[0];
  if (provider === undefined) {
    // Loader enforces min-length 1, but keep the check for type narrowing.
    throw new Error(`fixture ${abs} has no providers`);
  }
  const agentId = resolveAgentId(provider.id);
  const llmRubricGrader = opts.llmRubricGrader ?? null;

  const cases: TestCaseResult[] = [];
  for (const test of fixture.tests) {
    const vars = test.vars ?? {};
    for (const prompt of fixture.prompts) {
      const output = await opts.runAgent({ agentId, prompt, vars });
      const assertions: AssertionResult[] = [];
      for (const a of test.assert) {
        assertions.push(await evaluateAssertion(a, output, { vars, llmRubricGrader }));
      }
      const { passed, score } = reduceCase(assertions);
      cases.push({
        description: test.description,
        prompt,
        output,
        assertions,
        score,
        passed,
      });
    }
  }

  const fixturePassed = cases.every((c) => c.passed);
  const meanScore =
    cases.length === 0 ? 1 : cases.reduce((sum, c) => sum + c.score, 0) / cases.length;

  return {
    fixturePath: abs,
    fixtureId: toForwardSlash(relative(process.cwd(), abs)),
    description: fixture.description,
    agentId,
    cases,
    score: meanScore,
    passed: fixturePassed,
    durationMs: Date.now() - start,
  };
}

/**
 * Run every fixture under `target` (file or directory) and assemble a report.
 *
 * `runId` is the hex form of a UUIDv4 so it sorts and prints cleanly in the
 * `eval_results` table the CLI bundle will write to.
 */
export async function runEvals(target: string, opts: EvalRunnerOptions): Promise<EvalRunReport> {
  const startedAt = new Date().toISOString();
  const paths = await discoverFixtures(target);

  const fixtures: FixtureResult[] = [];
  for (const p of paths) {
    fixtures.push(await runFixture(p, opts));
  }

  const finishedAt = new Date().toISOString();
  return {
    runId: randomUUID().replace(/-/g, ''),
    startedAt,
    finishedAt,
    fixtures,
    passed: fixtures.every((f) => f.passed),
    modelGradedEnabled: (opts.llmRubricGrader ?? null) !== null,
  };
}
