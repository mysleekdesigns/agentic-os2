/**
 * CLI tests for `agent-os show <run-id>` (PRD §3 Phase 8).
 *
 * This is the Phase 8 exit-criterion surface: after a multi-step run, `show`
 * must print a tree of agent calls, tool calls, durations, and outcomes that
 * matches reality.
 *
 * Strategy:
 *  - Bring up a real tmp workspace via `runInit`.
 *  - Open the same SQLite DB the CLI will open (`<workspace>/.agent-os/db.sqlite`).
 *  - Seed an agent + run row, then build a multi-level span tree using the
 *    engine's own `createSpanEmitter` so the persisted JSON shape is whatever
 *    the engine actually writes (we don't fabricate the envelope).
 *  - Drive the command via `buildShowCommand()` + `parseAsync` exactly the
 *    way `tests/cli/workflow.test.ts` drives Commander.
 *
 * The exit criterion test counts spans/agents/tool_calls in the resulting
 * tree and matches them back to the seeded structure.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildShowCommand } from '../../src/cli/commands/show.js';
import { runInit } from '../../src/cli/commands/init.js';
import { openDatabase, type AgentOsDb } from '../../src/storage/db.js';
import { runMigrations } from '../../src/storage/migrate.js';
import { agents, runs, steps as stepsTable } from '../../src/storage/schema.js';
import { createSpanEmitter, type SpanEmitter } from '../../src/core/observability/index.js';
import type { SpanContext } from '../../src/core/observability/index.js';

// ---------------------------------------------------------------------------
// CLI harness — mirrors tests/cli/workflow.test.ts
// ---------------------------------------------------------------------------

async function runShowCli(argv: readonly string[]): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
}> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  let exitCode: number | null = null;

  const writeStdout = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    });
  const writeStderr = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    });
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`__exit_${exitCode}__`);
  }) as (code?: number) => never);

  const program = new Command();
  program.exitOverride();
  program.addCommand(buildShowCommand());

  try {
    await program.parseAsync(['node', 'agent-os', 'show', ...argv]);
  } catch (err) {
    void err;
  } finally {
    writeStdout.mockRestore();
    writeStderr.mockRestore();
    exit.mockRestore();
  }

  return { stdout: stdoutChunks.join(''), stderr: stderrChunks.join(''), exitCode };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Seeded {
  runId: string;
  workflowCtx: SpanContext;
  agentCtxs: SpanContext[];
  toolCtxs: SpanContext[];
  durations: Map<string, number>;
}

interface SpanPlan {
  startMs: number;
  endMs: number;
  status: 'ok' | 'error' | 'cancelled';
}

/**
 * Seed: one workflow span → two agent spans → two tool_call spans under
 * each agent. Returns the contexts plus a map of spanId → duration ms so
 * tests can assert durations independent of the seed timestamps.
 *
 * We back the clock with a hand-cranked sequence so durations are stable.
 */
async function seedMultiStepRun(db: AgentOsDb): Promise<Seeded> {
  const runId = 'run-show-1';
  await db.insert(agents).values({
    id: 'lead',
    version: '1',
    definitionPath: 'agents/lead.md',
    hash: '0',
    createdAt: new Date(),
  });
  await db.insert(runs).values({
    id: runId,
    agentId: 'lead',
    workflowId: 'demo',
    status: 'succeeded',
    startedAt: new Date(1_700_000_000_000),
    endedAt: new Date(1_700_000_010_000),
    provider: 'fake',
    model: 'fake-model',
    summary: 'seeded by show.test.ts',
  });

  // Also write a couple of `steps` rows so the steps section renders.
  await db.insert(stepsTable).values({
    id: 'step-1',
    runId,
    kind: 'message',
    name: 'message:1',
    status: 'succeeded',
    startedAt: new Date(1_700_000_000_500),
    endedAt: new Date(1_700_000_001_000),
    error: null,
    inputRef: null,
    outputRef: null,
  });

  // Hand-cranked clock so we know the exact start/end of every span.
  let tick = 1_700_000_000_000;
  const advance = (by: number): number => {
    tick += by;
    return tick;
  };

  const emitter: SpanEmitter = createSpanEmitter({
    db,
    clock: () => tick,
  });

  // Plan all spans before emitting so we can return durations cleanly.
  const wfPlan: SpanPlan = {
    startMs: 1_700_000_000_000,
    endMs: 1_700_000_010_000,
    status: 'ok',
  };
  const agentPlans: SpanPlan[] = [
    { startMs: 1_700_000_001_000, endMs: 1_700_000_004_000, status: 'ok' },
    { startMs: 1_700_000_005_000, endMs: 1_700_000_009_000, status: 'ok' },
  ];
  const toolPlans: SpanPlan[][] = [
    [
      { startMs: 1_700_000_001_100, endMs: 1_700_000_001_350, status: 'ok' },
      { startMs: 1_700_000_002_000, endMs: 1_700_000_003_800, status: 'ok' },
    ],
    [
      { startMs: 1_700_000_005_100, endMs: 1_700_000_005_900, status: 'ok' },
      { startMs: 1_700_000_006_000, endMs: 1_700_000_008_500, status: 'error' },
    ],
  ];

  const durations = new Map<string, number>();
  const agentCtxs: SpanContext[] = [];
  const toolCtxs: SpanContext[] = [];

  // Workflow start.
  tick = wfPlan.startMs;
  const wfCtx = emitter.start({
    kind: 'workflow',
    name: 'workflow:demo',
    runId,
    attributes: { 'agent_os.workflow_id': 'demo' },
  });

  for (let i = 0; i < agentPlans.length; i++) {
    const aPlan = agentPlans[i]!;
    tick = aPlan.startMs;
    const aCtx = emitter.start({
      kind: 'agent',
      name: `agent:worker-${i}`,
      runId,
      parent: wfCtx,
      attributes: {
        'gen_ai.request.model': 'fake-model',
        // Deliberately leave one agent without input_tokens to exercise the
        // nullability path in renderers.
        ...(i === 0 ? { 'gen_ai.usage.input_tokens': 42 } : {}),
        'gen_ai.usage.output_tokens': i === 0 ? 17 : null,
      },
    });
    agentCtxs.push(aCtx);

    for (let j = 0; j < toolPlans[i]!.length; j++) {
      const tPlan = toolPlans[i]![j]!;
      tick = tPlan.startMs;
      const tCtx = emitter.start({
        kind: 'tool_call',
        name: `tool:do-${i}-${j}`,
        runId,
        parent: aCtx,
        attributes: { 'tool.risk': 'read' },
      });
      toolCtxs.push(tCtx);
      tick = tPlan.endMs;
      emitter.end(tCtx, tPlan.status);
      durations.set(tCtx.spanId, tPlan.endMs - tPlan.startMs);
    }

    tick = aPlan.endMs;
    emitter.end(aCtx, aPlan.status);
    durations.set(aCtx.spanId, aPlan.endMs - aPlan.startMs);
  }

  tick = wfPlan.endMs;
  emitter.end(wfCtx, wfPlan.status);
  durations.set(wfCtx.spanId, wfPlan.endMs - wfPlan.startMs);

  await emitter.flush();
  void advance;

  return { runId, workflowCtx: wfCtx, agentCtxs, toolCtxs, durations };
}

interface ShowJsonSpan {
  context: { spanId: string; parentSpanId?: string; traceId: string; runId: string };
  kind: string;
  name: string;
  startTimeMs: number;
  endTimeMs: number | null;
  status: string;
  attributes: Record<string, unknown>;
}

interface ShowJsonPayload {
  run: {
    id: string;
    workflow_id: string | null;
    agent_id: string;
    status: string;
    started_at: number | null;
    ended_at: number | null;
    duration_ms: number | null;
  };
  steps: Array<{ id: string; status: string }>;
  toolCalls: unknown[];
  approvalsPending: unknown[];
  traces: ShowJsonSpan[];
}

interface TreeNode {
  span: ShowJsonSpan;
  children: TreeNode[];
}

function buildTree(spans: ShowJsonSpan[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  for (const s of spans) {
    byId.set(s.context.spanId, { span: s, children: [] });
  }
  const roots: TreeNode[] = [];
  for (const node of byId.values()) {
    const parentId = node.span.context.parentSpanId;
    if (parentId !== undefined && byId.has(parentId)) {
      byId.get(parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('agent-os show <run-id>', () => {
  let tmpDir: string;
  let originalCwd: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agent-os-show-'));
    runInit({ cwd: tmpDir });
    originalCwd = process.cwd();
    process.chdir(tmpDir);
    dbPath = join(tmpDir, '.agent-os', 'db.sqlite');

    const db = openDatabase(dbPath);
    try {
      await runMigrations(db, { log: () => undefined });
    } finally {
      db.$sqlite.close();
    }
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('Phase 8 Exit — show prints a tree matching reality after a multi-step run', async () => {
    // Seed using the CLI's DB path.
    const db = openDatabase(dbPath);
    let seeded: Seeded;
    try {
      seeded = await seedMultiStepRun(db);
    } finally {
      db.$sqlite.close();
    }

    const { stdout, stderr, exitCode } = await runShowCli([seeded.runId, '--json']);
    expect(stderr).toBe('');
    expect(exitCode === null || exitCode === 0).toBe(true);

    const payload = JSON.parse(stdout) as ShowJsonPayload;
    expect(payload.run.id).toBe(seeded.runId);
    expect(payload.run.workflow_id).toBe('demo');

    // 1 workflow + 2 agents + 4 tool_calls = 7 spans total.
    const expectedSpanCount = 1 + seeded.agentCtxs.length + seeded.toolCtxs.length;
    expect(payload.traces).toHaveLength(expectedSpanCount);

    // Build a tree from the flat list and assert shape.
    const roots = buildTree(payload.traces);
    expect(roots).toHaveLength(1);
    const wf = roots[0]!;
    expect(wf.span.kind).toBe('workflow');
    expect(wf.span.context.spanId).toBe(seeded.workflowCtx.spanId);
    expect(wf.children).toHaveLength(2);

    for (const agentNode of wf.children) {
      expect(agentNode.span.kind).toBe('agent');
      expect(agentNode.children).toHaveLength(2);
      for (const toolNode of agentNode.children) {
        expect(toolNode.span.kind).toBe('tool_call');
      }
    }

    // Durations on every node must equal endTimeMs - startTimeMs of the
    // seeded span. Outcomes must match status.
    for (const span of payload.traces) {
      expect(span.endTimeMs).not.toBeNull();
      const dur = (span.endTimeMs ?? 0) - span.startTimeMs;
      const expected = seeded.durations.get(span.context.spanId);
      expect(expected).toBeDefined();
      expect(dur).toBe(expected);
    }

    // Outcomes: one tool_call seeded as `error`, the rest `ok`.
    const errors = payload.traces.filter((s) => s.status === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.kind).toBe('tool_call');
  });

  it('pretty output (default, no --json) renders a line per span', async () => {
    const db = openDatabase(dbPath);
    let seeded: Seeded;
    try {
      seeded = await seedMultiStepRun(db);
    } finally {
      db.$sqlite.close();
    }

    const { stdout, exitCode } = await runShowCli([seeded.runId]);
    expect(exitCode === null || exitCode === 0).toBe(true);

    // Every seeded span name should appear at least once in the pretty
    // output — we don't pin the exact unicode glyphs / branch characters.
    expect(stdout).toMatch(/workflow:demo/);
    expect(stdout).toMatch(/agent:worker-0/);
    expect(stdout).toMatch(/agent:worker-1/);
    expect(stdout).toMatch(/tool:do-0-0/);
    expect(stdout).toMatch(/tool:do-0-1/);
    expect(stdout).toMatch(/tool:do-1-0/);
    expect(stdout).toMatch(/tool:do-1-1/);
    // And the header line for the run.
    expect(stdout).toMatch(new RegExp(`Run ${seeded.runId}`));
  });

  it('renders the "no spans recorded" stanza when no traces exist for the run', async () => {
    // Seed a run with NO traces — covers the observability.traces=false path.
    const db = openDatabase(dbPath);
    const runId = 'run-no-traces';
    try {
      await db.insert(agents).values({
        id: 'solo',
        version: '1',
        definitionPath: 'agents/solo.md',
        hash: '0',
        createdAt: new Date(),
      });
      await db.insert(runs).values({
        id: runId,
        agentId: 'solo',
        status: 'succeeded',
        startedAt: new Date(1_700_000_000_000),
        endedAt: new Date(1_700_000_001_000),
        provider: 'fake',
        model: 'fake-model',
      });
      await db.insert(stepsTable).values({
        id: 'step-only',
        runId,
        kind: 'message',
        name: 'step:only',
        status: 'succeeded',
        startedAt: new Date(1_700_000_000_100),
        endedAt: new Date(1_700_000_000_900),
        error: null,
        inputRef: null,
        outputRef: null,
      });
    } finally {
      db.$sqlite.close();
    }

    const { stdout, exitCode } = await runShowCli([runId]);
    expect(exitCode === null || exitCode === 0).toBe(true);
    expect(stdout).toMatch(/no spans recorded/);
    // The run + steps still render.
    expect(stdout).toMatch(new RegExp(`Run ${runId}`));
    expect(stdout).toMatch(/step:only/);
  });

  it('exits non-zero with a clear error for a missing run id', async () => {
    const { stderr, exitCode } = await runShowCli([
      '00000000-0000-0000-0000-000000000000',
      '--json',
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/not found/);
  });

  it('renders "—" for nullable cost/tokens when the provider did not surface usage', async () => {
    // Seed a run with one agent span whose usage attrs are explicitly null.
    const db = openDatabase(dbPath);
    const runId = 'run-null-usage';
    try {
      await db.insert(agents).values({
        id: 'maxer',
        version: '1',
        definitionPath: 'agents/maxer.md',
        hash: '0',
        createdAt: new Date(),
      });
      await db.insert(runs).values({
        id: runId,
        agentId: 'maxer',
        status: 'succeeded',
        startedAt: new Date(1_700_000_000_000),
        endedAt: new Date(1_700_000_001_000),
        provider: 'fake',
        model: 'fake-model',
      });
      let tick = 1_700_000_000_000;
      const emitter = createSpanEmitter({ db, clock: () => tick });
      const wf = emitter.start({ kind: 'workflow', name: 'workflow:null', runId });
      tick = 1_700_000_000_100;
      const a = emitter.start({
        kind: 'agent',
        name: 'agent:max',
        runId,
        parent: wf,
        attributes: {
          'gen_ai.request.model': 'fake-model',
          'gen_ai.usage.input_tokens': null,
          'gen_ai.usage.output_tokens': null,
          'gen_ai.usage.cost_usd': null,
        },
      });
      tick = 1_700_000_000_900;
      emitter.end(a, 'ok');
      tick = 1_700_000_001_000;
      emitter.end(wf, 'ok');
      await emitter.flush();
    } finally {
      db.$sqlite.close();
    }

    const { stdout, exitCode } = await runShowCli([runId]);
    expect(exitCode === null || exitCode === 0).toBe(true);
    // Both the cost and the tokens columns must dash out.
    expect(stdout).toMatch(/agent:max/);
    expect(stdout).toMatch(/—/);
    // No fabricated zero.
    expect(stdout).not.toMatch(/cost=\$0(\s|$)/);
  });

  it('runs with ANTHROPIC_API_KEY and OPENAI_API_KEY unset (PRD §4 quality bar)', async () => {
    const savedAnthropic = process.env.ANTHROPIC_API_KEY;
    const savedOpenai = process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      const db = openDatabase(dbPath);
      let seeded: Seeded;
      try {
        seeded = await seedMultiStepRun(db);
      } finally {
        db.$sqlite.close();
      }

      const { stdout, exitCode } = await runShowCli([seeded.runId, '--json']);
      expect(exitCode === null || exitCode === 0).toBe(true);
      const parsed = JSON.parse(stdout) as ShowJsonPayload;
      expect(parsed.run.id).toBe(seeded.runId);
    } finally {
      if (savedAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = savedAnthropic;
      if (savedOpenai !== undefined) process.env.OPENAI_API_KEY = savedOpenai;
    }
  });
});
