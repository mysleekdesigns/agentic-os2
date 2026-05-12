import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runEvals, runFixture, type RunAgentFn } from '../../../src/core/eval/runner.js';

const FIXTURE_YAML = `description: 'in-memory test'
prompts:
  - 'first prompt'
  - 'second prompt'
providers:
  - id: agent-os:demo_agent
tests:
  - description: 'must contain greeting and a number'
    assert:
      - type: contains
        value: 'hello'
      - type: regex
        value: '\\d+'
      - type: llm-rubric
        value: 'is friendly'
`;

describe('runFixture', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-os-eval-runner-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('runs every prompt × case and aggregates results', async () => {
    const file = join(dir, 'fixture.yaml');
    await writeFile(file, FIXTURE_YAML, 'utf8');

    const calls: Array<{ agentId: string; prompt: string }> = [];
    const runAgent: RunAgentFn = async ({ agentId, prompt }) => {
      calls.push({ agentId, prompt });
      return `hello from ${agentId} 42`;
    };

    const result = await runFixture(file, { runAgent });

    expect(result.agentId).toBe('demo_agent');
    expect(result.cases).toHaveLength(2); // 1 case × 2 prompts
    expect(calls.map((c) => c.prompt)).toEqual(['first prompt', 'second prompt']);
    expect(calls.every((c) => c.agentId === 'demo_agent')).toBe(true);

    for (const c of result.cases) {
      // contains + regex pass; llm-rubric is skipped (no grader)
      expect(c.passed).toBe(true);
      expect(c.score).toBe(1);
      expect(c.assertions).toHaveLength(3);
      const rubric = c.assertions.find((a) => a.type === 'llm-rubric');
      expect(rubric?.skipped).toBe(true);
      expect(rubric?.passed).toBe(true);
    }
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.fixtureId).toMatch(/fixture\.yaml$/);
  });

  it('marks the fixture failed when at least one assertion fails', async () => {
    const file = join(dir, 'fail.yaml');
    await writeFile(file, FIXTURE_YAML, 'utf8');

    // Missing the digit; "hello" still present.
    const runAgent: RunAgentFn = async () => 'hello with no numbers';

    const result = await runFixture(file, { runAgent });

    expect(result.passed).toBe(false);
    expect(result.cases.every((c) => c.passed === false)).toBe(true);
    // Partial credit: 1 contains-pass + 1 regex-fail + 1 llm-rubric-skip => 2/3.
    for (const c of result.cases) {
      expect(c.score).toBeCloseTo(2 / 3, 5);
    }
    expect(result.score).toBeCloseTo(2 / 3, 5);
  });

  it('strips agent-os: prefix and falls back to the raw id', async () => {
    const fileA = join(dir, 'a.yaml');
    const fileB = join(dir, 'b.yaml');
    await writeFile(
      fileA,
      `prompts:\n  - p\nproviders:\n  - id: agent-os:foo\ntests:\n  - assert:\n      - type: contains\n        value: x\n`,
      'utf8',
    );
    await writeFile(
      fileB,
      `prompts:\n  - p\nproviders:\n  - id: bare_agent\ntests:\n  - assert:\n      - type: contains\n        value: x\n`,
      'utf8',
    );
    const runAgent: RunAgentFn = async () => 'x';

    expect((await runFixture(fileA, { runAgent })).agentId).toBe('foo');
    expect((await runFixture(fileB, { runAgent })).agentId).toBe('bare_agent');
  });

  it('invokes the llm-rubric grader when configured', async () => {
    const file = join(dir, 'rubric.yaml');
    await writeFile(file, FIXTURE_YAML, 'utf8');

    let graderCalls = 0;
    const runAgent: RunAgentFn = async () => 'hello 7';
    const result = await runFixture(file, {
      runAgent,
      llmRubricGrader: async () => {
        graderCalls += 1;
        return { passed: true, reason: 'looks good' };
      },
    });
    expect(graderCalls).toBe(2); // 2 prompts × 1 case
    for (const c of result.cases) {
      const rubric = c.assertions.find((a) => a.type === 'llm-rubric');
      expect(rubric?.skipped).toBe(false);
      expect(rubric?.passed).toBe(true);
    }
  });
});

describe('runEvals', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-os-eval-runEvals-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('runs every fixture under a directory and produces a stable report shape', async () => {
    await writeFile(join(dir, 'a.yaml'), FIXTURE_YAML, 'utf8');
    await writeFile(join(dir, 'b.yaml'), FIXTURE_YAML, 'utf8');
    const runAgent: RunAgentFn = async () => 'hello 1';

    const report = await runEvals(dir, { runAgent });

    expect(report.fixtures).toHaveLength(2);
    expect(report.passed).toBe(true);
    expect(report.modelGradedEnabled).toBe(false);
    expect(report.runId).toMatch(/^[a-f0-9]{32}$/);
    expect(typeof report.startedAt).toBe('string');
    expect(typeof report.finishedAt).toBe('string');
  });

  it('reports modelGradedEnabled=true when a grader is provided', async () => {
    await writeFile(join(dir, 'a.yaml'), FIXTURE_YAML, 'utf8');
    const report = await runEvals(dir, {
      runAgent: async () => 'hello 1',
      llmRubricGrader: async () => ({ passed: true }),
    });
    expect(report.modelGradedEnabled).toBe(true);
  });
});
