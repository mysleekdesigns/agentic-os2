import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  discoverFixtures,
  EvalFixtureError,
  loadFixtureFile,
} from '../../../src/core/eval/loader.js';

const REPO_ROOT = resolve(__dirname, '../../..');
const FIXTURE_ROOT = join(REPO_ROOT, 'evals', 'fixtures');

describe('loadFixtureFile — existing fixtures', () => {
  it.each([
    ['research_agent', 'research_agent'],
    ['code_reviewer', 'code_reviewer'],
    ['doc_writer', 'doc_writer'],
  ])('parses evals/fixtures/%s/smoke.yaml', async (dir, expectedAgent) => {
    const path = join(FIXTURE_ROOT, dir, 'smoke.yaml');
    const fixture = await loadFixtureFile(path);

    expect(fixture.prompts.length).toBeGreaterThanOrEqual(1);
    expect(fixture.providers[0]?.id).toBe(`agent-os:${expectedAgent}`);
    expect(fixture.tests.length).toBeGreaterThanOrEqual(1);

    const first = fixture.tests[0];
    expect(first?.assert.length).toBeGreaterThan(0);
    for (const a of first?.assert ?? []) {
      expect(typeof a.type).toBe('string');
      expect(a.type.startsWith('not-')).toBe(false); // normalised away
    }

    // Each fixture currently includes one llm-rubric assertion.
    const hasRubric = first?.assert.some((a) => a.type === 'llm-rubric') ?? false;
    expect(hasRubric).toBe(true);
  });
});

describe('loadFixtureFile — malformed inputs', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-os-eval-loader-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('throws on invalid YAML', async () => {
    const file = join(dir, 'bad.yaml');
    await writeFile(file, ': : :\n  not-yaml: [unterminated\n', 'utf8');
    await expect(loadFixtureFile(file)).rejects.toBeInstanceOf(EvalFixtureError);
  });

  it('rejects fixtures missing `prompts`', async () => {
    const file = join(dir, 'noprompts.yaml');
    await writeFile(
      file,
      `providers:\n  - id: agent-os:foo\ntests:\n  - assert:\n      - type: contains\n        value: hi\n`,
      'utf8',
    );
    await expect(loadFixtureFile(file)).rejects.toBeInstanceOf(EvalFixtureError);
  });

  it('rejects unknown assertion types', async () => {
    const file = join(dir, 'unknown.yaml');
    await writeFile(
      file,
      `prompts:\n  - hello\nproviders:\n  - id: agent-os:foo\ntests:\n  - assert:\n      - type: telekinesis\n        value: blah\n`,
      'utf8',
    );
    await expect(loadFixtureFile(file)).rejects.toBeInstanceOf(EvalFixtureError);
  });

  it('rejects required-value assertions with no value', async () => {
    const file = join(dir, 'novalue.yaml');
    await writeFile(
      file,
      `prompts:\n  - hello\nproviders:\n  - id: agent-os:foo\ntests:\n  - assert:\n      - type: contains\n`,
      'utf8',
    );
    await expect(loadFixtureFile(file)).rejects.toBeInstanceOf(EvalFixtureError);
  });

  it('accepts is-json without a value', async () => {
    const file = join(dir, 'isjson.yaml');
    await writeFile(
      file,
      `prompts:\n  - hello\nproviders:\n  - id: agent-os:foo\ntests:\n  - assert:\n      - type: is-json\n`,
      'utf8',
    );
    const fixture = await loadFixtureFile(file);
    expect(fixture.tests[0]?.assert[0]?.type).toBe('is-json');
  });

  it('normalises not-X into {type: X, negate: true}', async () => {
    const file = join(dir, 'notprefix.yaml');
    await writeFile(
      file,
      `prompts:\n  - hello\nproviders:\n  - id: agent-os:foo\ntests:\n  - assert:\n      - type: not-contains\n        value: forbidden\n`,
      'utf8',
    );
    const fixture = await loadFixtureFile(file);
    const a = fixture.tests[0]?.assert[0];
    expect(a?.type).toBe('contains');
    expect(a?.negate).toBe(true);
    expect(a?.value).toBe('forbidden');
  });

  it('throws on a missing target', async () => {
    await expect(loadFixtureFile(join(dir, 'does-not-exist.yaml'))).rejects.toBeInstanceOf(
      EvalFixtureError,
    );
  });
});

describe('discoverFixtures', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-os-eval-discover-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns a single-element array for a file target', async () => {
    const file = join(dir, 'a.yaml');
    await writeFile(file, 'x: 1', 'utf8');
    const out = await discoverFixtures(file);
    expect(out).toEqual([resolve(file)]);
  });

  it('walks a directory and returns sorted YAML files', async () => {
    const a = join(dir, 'a.yaml');
    const b = join(dir, 'nested', 'b.yml');
    await writeFile(a, 'x: 1', 'utf8');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, 'nested'), { recursive: true });
    await writeFile(b, 'x: 1', 'utf8');
    // Drop a non-YAML to confirm filtering.
    await writeFile(join(dir, 'README.md'), '# hi', 'utf8');

    const out = await discoverFixtures(dir);
    expect(out).toEqual([resolve(a), resolve(b)].sort());
  });

  it('throws on a missing target', async () => {
    await expect(discoverFixtures(join(dir, 'nope'))).rejects.toBeInstanceOf(EvalFixtureError);
  });
});
