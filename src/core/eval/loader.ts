/**
 * YAML fixture loader for the Agent OS eval framework.
 *
 * Accepts Promptfoo-style fixtures verbatim (see `evals/fixtures/<agent>/smoke.yaml`)
 * and normalises Promptfoo's `not-<type>` shorthand into a structured
 * `{ type, negate: true }` so the scorer layer never has to parse strings.
 *
 * Validation is intentionally strict: every assertion that requires a `value`
 * must have one. The only exception is `is-json`, which is purely structural.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';

import yaml from 'js-yaml';
import { z, ZodError } from 'zod';

import type { Assertion, AssertionType, FixtureFile } from './types.js';

/** Error thrown when a fixture cannot be parsed or fails schema validation. */
export class EvalFixtureError extends Error {
  constructor(
    public readonly file: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(`eval fixture invalid (${file}): ${message}`);
    this.name = 'EvalFixtureError';
  }
}

const KNOWN_TYPES: ReadonlySet<AssertionType> = new Set<AssertionType>([
  'regex',
  'contains',
  'contains-any',
  'contains-all',
  'icontains',
  'icontains-any',
  'is-json',
  'javascript',
  'llm-rubric',
]);

/** Types that do not require a `value` field. */
const VALUE_OPTIONAL: ReadonlySet<AssertionType> = new Set<AssertionType>(['is-json']);

// Permissive schema: we accept Promptfoo's raw types (including `not-X`) and
// normalise them ourselves before final validation. zod is used only for the
// outer shape; per-assertion semantic checks live in `normaliseAssertion`.
const RawAssertionSchema = z.object({
  type: z.string().min(1),
  value: z.unknown().optional(),
  provider: z.string().optional(),
  weight: z.number().positive().optional(),
  negate: z.boolean().optional(),
});

const RawTestCaseSchema = z.object({
  description: z.string().optional(),
  vars: z.record(z.string()).optional(),
  assert: z.array(RawAssertionSchema).min(1),
});

const RawFixtureSchema = z.object({
  description: z.string().optional(),
  prompts: z.array(z.string().min(1)).min(1),
  providers: z.array(z.object({ id: z.string().min(1) })).min(1),
  tests: z.array(RawTestCaseSchema).min(1),
});

function normaliseAssertion(file: string, raw: z.infer<typeof RawAssertionSchema>): Assertion {
  let type = raw.type;
  let negate = raw.negate ?? false;

  // Promptfoo: `not-X` is the negated form of `X`.
  if (type.startsWith('not-')) {
    negate = !negate;
    type = type.slice('not-'.length);
  }

  if (!KNOWN_TYPES.has(type as AssertionType)) {
    throw new EvalFixtureError(file, `unknown assertion type "${raw.type}"`);
  }
  const t = type as AssertionType;

  if (!VALUE_OPTIONAL.has(t) && raw.value === undefined) {
    throw new EvalFixtureError(file, `assertion type "${t}" requires a "value"`);
  }

  const out: Assertion = { type: t, negate, value: raw.value };
  if (raw.provider !== undefined) out.provider = raw.provider;
  if (raw.weight !== undefined) out.weight = raw.weight;
  return out;
}

/**
 * Load and validate a single fixture file. Returns a fully-normalised
 * `FixtureFile`; assertions of the form `not-X` have been rewritten to
 * `{ type: X, negate: true }`.
 */
export async function loadFixtureFile(absPath: string): Promise<FixtureFile> {
  const file = resolve(absPath);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    throw new EvalFixtureError(file, err instanceof Error ? err.message : String(err), err);
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new EvalFixtureError(file, `invalid YAML: ${msg}`, err);
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new EvalFixtureError(file, 'fixture root must be a YAML mapping');
  }

  let raw: z.infer<typeof RawFixtureSchema>;
  try {
    raw = RawFixtureSchema.parse(parsed);
  } catch (err) {
    if (err instanceof ZodError) {
      const summary = err.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ');
      throw new EvalFixtureError(file, `schema validation failed: ${summary}`, err);
    }
    throw err;
  }

  const tests = raw.tests.map((t) => ({
    description: t.description,
    vars: t.vars,
    assert: t.assert.map((a) => normaliseAssertion(file, a)),
  }));

  return {
    description: raw.description,
    prompts: raw.prompts,
    providers: raw.providers,
    tests,
  };
}

/**
 * Resolve a target path to a sorted list of fixture files.
 *
 * - File path: returns `[target]` (extension is not checked — callers can pass
 *   a `.yml` or `.yaml` file directly).
 * - Directory: recursively returns every `*.yaml` / `*.yml` file under it,
 *   sorted for deterministic run ordering.
 *
 * Throws if the target does not exist.
 */
export async function discoverFixtures(target: string): Promise<string[]> {
  const abs = resolve(target);
  let s;
  try {
    s = await stat(abs);
  } catch (err) {
    throw new EvalFixtureError(
      abs,
      `target not found: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  if (s.isFile()) return [abs];
  if (!s.isDirectory()) {
    throw new EvalFixtureError(abs, 'target is neither a file nor a directory');
  }

  const out: string[] = [];
  await walkYaml(abs, out);
  out.sort();
  return out;
}

async function walkYaml(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = dir + sep + entry.name;
    if (entry.isDirectory()) {
      await walkYaml(full, out);
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      if (ext === '.yaml' || ext === '.yml') out.push(full);
    }
  }
}
