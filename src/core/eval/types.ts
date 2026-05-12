/**
 * Type surface for the Agent OS evaluation framework (PRD §3 Phase 9).
 *
 * Fixtures are Promptfoo-compatible YAML where possible. The runner is a pure
 * library: it loads fixtures, runs agent calls via a caller-supplied function,
 * and produces a deterministic `EvalRunReport` that the CLI bundle (`phase9-cli`)
 * is free to persist into the `eval_results` table.
 *
 * Scorers fall into three families per PRD Phase 9:
 *   - deterministic (regex, JSON shape, citation presence)
 *   - programmatic (custom JS expressions)
 *   - optional model-graded (only when an API-backed provider is configured;
 *     skipped cleanly otherwise so the Claude Code Max / no-API-key path still
 *     produces a usable score).
 */

export interface FixtureFile {
  description?: string;
  /** At least one prompt; each prompt is run against every test case. */
  prompts: string[];
  /** Each provider id is `agent-os:<agentId>` or a bare `<agentId>`. */
  providers: Array<{ id: string }>;
  tests: TestCase[];
}

export interface TestCase {
  description?: string;
  vars?: Record<string, string>;
  assert: Assertion[];
}

export type AssertionType =
  | 'regex'
  | 'contains'
  | 'contains-any'
  | 'contains-all'
  | 'icontains'
  | 'icontains-any'
  | 'is-json'
  | 'javascript'
  | 'llm-rubric';

export interface Assertion {
  type: AssertionType;
  /** Promptfoo's `not-X` is normalised to `type: X, negate: true` during load. */
  negate?: boolean;
  value?: unknown;
  /** Only meaningful for `llm-rubric`. */
  provider?: string;
  /** Default 1. */
  weight?: number;
}

export interface AssertionResult {
  type: AssertionType;
  passed: boolean;
  /**
   * True when the scorer was skipped (e.g. `llm-rubric` with no API-backed
   * provider available). Skipped assertions do NOT fail their case and contribute
   * a passing weight to the score so that absent model-graded checks do not tank
   * an otherwise-clean run.
   */
  skipped: boolean;
  reason?: string;
  weight: number;
}

export interface TestCaseResult {
  description?: string;
  prompt: string;
  output: string;
  assertions: AssertionResult[];
  /** Weighted score over the case's assertions, in [0, 1]. */
  score: number;
  /** True iff every non-skipped assertion passed. */
  passed: boolean;
}

export interface FixtureResult {
  fixturePath: string;
  /** Path relative to `process.cwd()`, slash-separated, for stable run ids. */
  fixtureId: string;
  description?: string;
  /** Resolved from `providers[0].id` with any `agent-os:` prefix stripped. */
  agentId: string;
  cases: TestCaseResult[];
  /** Mean of case scores. */
  score: number;
  /** True iff every case passed. */
  passed: boolean;
  durationMs: number;
}

export interface EvalRunReport {
  /** Hex form of a UUIDv4 (dashes stripped). */
  runId: string;
  startedAt: string;
  finishedAt: string;
  fixtures: FixtureResult[];
  /** True iff every fixture passed. */
  passed: boolean;
  /** Was an `llm-rubric` grader available this run? */
  modelGradedEnabled: boolean;
}
