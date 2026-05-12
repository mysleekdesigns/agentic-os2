/**
 * Loader / schema tests for the workflow engine (PRD §3 Phase 5 item 1).
 *
 * Exercises the public surface re-exported by `src/core/tasks/index.ts`:
 *   - `parseWorkflowDef` for in-memory validation
 *   - `loadWorkflow` for single-file load
 *   - `loadWorkflows` for directory walk + dedupe
 *
 * The two shipped example workflows under `workflows/examples/` are also
 * exercised so the PRD's "ship two example workflows" item is covered.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  loadWorkflow,
  loadWorkflows,
  parseWorkflowDef,
  WorkflowLoadError,
  WorkflowParseError,
} from '../../../src/core/tasks/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const WORKFLOWS_EXAMPLES_DIR = resolve(REPO_ROOT, 'workflows', 'examples');

// ---------------------------------------------------------------------------
// In-memory parseWorkflowDef cases
// ---------------------------------------------------------------------------

describe('parseWorkflowDef', () => {
  it('round-trips a workflow exercising every step kind', () => {
    const raw = {
      id: 'omni',
      version: 1,
      description: 'covers every step kind',
      inputs: [{ name: 'topic', type: 'string', required: true }],
      steps: [
        {
          kind: 'agent',
          id: 'plan',
          agent: 'planner',
          goal: 'plan ${inputs.topic}',
          retry: { max_attempts: 2, backoff_ms: 100, multiplier: 2 },
          timeout_ms: 5000,
        },
        {
          kind: 'parallel',
          id: 'fan',
          branches: [
            [{ kind: 'agent', id: 'left', agent: 'worker', goal: 'left' }],
            [{ kind: 'agent', id: 'right', agent: 'worker', goal: 'right' }],
          ],
        },
        {
          kind: 'conditional',
          id: 'route',
          when: "outputs['plan'].verdict === 'ok'",
          then: [{ kind: 'agent', id: 'apply', agent: 'doer', goal: 'apply' }],
          else: [{ kind: 'agent', id: 'revise', agent: 'doer', goal: 'revise' }],
        },
        { kind: 'approval', id: 'human', prompt: 'ship it?', risk: 'write' },
        {
          kind: 'wait_event',
          id: 'wait-merge',
          event_kind: 'merge_completed',
          match: { branch: 'main' },
          timeout_ms: 600000,
        },
        {
          kind: 'sequence',
          id: 'wrap',
          steps: [{ kind: 'agent', id: 'finalize', agent: 'doer', goal: 'wrap' }],
        },
      ],
    };

    const def = parseWorkflowDef(raw);
    expect(def.id).toBe('omni');
    expect(def.version).toBe(1);
    expect(def.steps).toHaveLength(6);
    // Discriminated union narrows cleanly:
    const kinds = def.steps.map((s) => s.kind);
    expect(kinds).toEqual([
      'agent',
      'parallel',
      'conditional',
      'approval',
      'wait_event',
      'sequence',
    ]);
  });

  it('throws WorkflowParseError when id is missing', () => {
    expect(() =>
      parseWorkflowDef({
        version: 1,
        steps: [{ kind: 'agent', id: 'a', agent: 'x', goal: 'go' }],
      }),
    ).toThrow(WorkflowParseError);
  });

  it('throws WorkflowParseError for an unknown step kind', () => {
    expect(() =>
      parseWorkflowDef({
        id: 'bad',
        version: 1,
        steps: [{ kind: 'launch_missile', id: 's1' }],
      }),
    ).toThrow(WorkflowParseError);
  });

  it('throws WorkflowParseError on duplicate step ids (even across branches)', () => {
    const raw = {
      id: 'dup',
      version: 1,
      steps: [
        { kind: 'agent', id: 'a', agent: 'x', goal: 'g' },
        {
          kind: 'parallel',
          id: 'p',
          branches: [[{ kind: 'agent', id: 'a', agent: 'x', goal: 'g' }]],
        },
      ],
    };
    expect(() => parseWorkflowDef(raw)).toThrow(/duplicate step id/);
  });

  it('throws WorkflowParseError on malformed retry policy', () => {
    expect(() =>
      parseWorkflowDef({
        id: 'r',
        version: 1,
        steps: [
          {
            kind: 'agent',
            id: 'a',
            agent: 'x',
            goal: 'g',
            // max_attempts must be int ≥ 1
            retry: { max_attempts: 0, backoff_ms: -5 },
          },
        ],
      }),
    ).toThrow(WorkflowParseError);
  });
});

// ---------------------------------------------------------------------------
// loadWorkflow / loadWorkflows
// ---------------------------------------------------------------------------

describe('loadWorkflow / loadWorkflows', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-os-wf-loader-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const minimalYaml = (id: string): string =>
    `id: ${id}
version: 1
steps:
  - kind: agent
    id: only-step
    agent: x
    goal: hello
`;

  it('loads a single workflow file and produces a sha256 hash', async () => {
    const file = join(dir, 'wf.yaml');
    await writeFile(file, minimalYaml('wf-one'), 'utf8');
    const wf = await loadWorkflow(file);
    expect(wf.def.id).toBe('wf-one');
    expect(wf.path).toBe(resolve(file));
    expect(wf.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('wraps a YAML parse failure in WorkflowLoadError', async () => {
    const file = join(dir, 'broken.yaml');
    await writeFile(file, ':\n  - this: [is, not, valid', 'utf8');
    await expect(loadWorkflow(file)).rejects.toBeInstanceOf(WorkflowLoadError);
  });

  it('wraps a schema failure in WorkflowLoadError', async () => {
    const file = join(dir, 'bad.yaml');
    await writeFile(file, 'id: missing-steps\nversion: 1\n', 'utf8');
    await expect(loadWorkflow(file)).rejects.toBeInstanceOf(WorkflowLoadError);
  });

  it('walks a directory of workflows and skips templates/', async () => {
    // Layout:
    //   <dir>/a.yaml          → loaded
    //   <dir>/sub/b.yml       → loaded (non-excluded subdir)
    //   <dir>/templates/c.yaml → SKIPPED
    await writeFile(join(dir, 'a.yaml'), minimalYaml('a'), 'utf8');
    await mkdir(join(dir, 'sub'));
    await writeFile(join(dir, 'sub', 'b.yml'), minimalYaml('b'), 'utf8');
    await mkdir(join(dir, 'templates'));
    await writeFile(join(dir, 'templates', 'c.yaml'), minimalYaml('c'), 'utf8');

    const found = await loadWorkflows(dir);
    const ids = found.map((w) => w.def.id).sort();
    expect(ids).toEqual(['a', 'b']);
    expect(ids).not.toContain('c');
  });

  it('throws WorkflowLoadError when two workflows share an id', async () => {
    await writeFile(join(dir, 'one.yaml'), minimalYaml('dup'), 'utf8');
    await writeFile(join(dir, 'two.yaml'), minimalYaml('dup'), 'utf8');
    await expect(loadWorkflows(dir)).rejects.toBeInstanceOf(WorkflowLoadError);
  });

  it('returns an empty array when the directory does not exist', async () => {
    const ghost = join(dir, 'does-not-exist');
    const found = await loadWorkflows(ghost);
    expect(found).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Shipped example workflows
// ---------------------------------------------------------------------------

describe('shipped example workflows', () => {
  it('workflows/examples/deep_research.yaml parses cleanly', async () => {
    const wf = await loadWorkflow(join(WORKFLOWS_EXAMPLES_DIR, 'deep_research.yaml'));
    expect(wf.def.id).toBe('deep-research');
    // Has the four documented top-level steps (research/write/review/route).
    const stepIds = wf.def.steps.map((s) => s.id);
    expect(stepIds).toEqual(['research', 'write', 'review', 'route']);
  });

  it('workflows/examples/bugfix_loop.yaml parses cleanly', async () => {
    const wf = await loadWorkflow(join(WORKFLOWS_EXAMPLES_DIR, 'bugfix_loop.yaml'));
    expect(wf.def.id).toBe('bugfix-loop');
    // The bugfix loop contains an approval and a parallel step.
    const kinds = wf.def.steps.map((s) => s.kind);
    expect(kinds).toContain('approval');
    expect(kinds).toContain('parallel');
  });
});
