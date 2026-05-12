/**
 * `agent-os eval` command group — Phase 9 (Evaluation framework).
 *
 * Provides two subcommands:
 *   - `agent-os eval run <fixture-or-dir>`: discovers fixtures, runs each via
 *     the provider abstraction (FakeProvider in tests, real adapters in prod),
 *     persists every `FixtureResult` to the `eval_results` table, and snapshots
 *     the full `EvalRunReport` to `<workspaceRoot>/.agent-os/eval-runs/<runId>.json`
 *     so `eval diff` never re-runs the agent.
 *   - `agent-os eval diff <run-a> <run-b>`: reads two snapshot reports and
 *     produces a fixture-level status table or JSON diff. Exits non-zero only
 *     when one or more fixtures *regressed* from A to B.
 *
 * The pure eval library lives in `../../core/eval/`; this file owns only the
 * CLI surface and the agent-run wiring (`RunAgentFn`).
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { Command } from 'commander';

import { loadConfig } from '../../config/index.js';
import { loadAgents, type AgentDefinition } from '../../core/agents/loader.js';
import {
  runEvals,
  type EvalRunReport,
  type FixtureResult,
  type LlmRubricGrader,
  type RunAgentFn,
} from '../../core/eval/index.js';
import {
  ensureBuiltinProvidersRegistered,
  getProvider,
  hasProvider,
  type AgentRunInput,
  type ProviderId,
} from '../../core/providers/index.js';
import { openDatabase, type AgentOsDb } from '../../storage/db.js';
import { runMigrations } from '../../storage/migrate.js';
import { evalResults } from '../../storage/schema.js';

// ---------------------------------------------------------------------------
// Workspace + DB helpers (mirrors the pattern in `agent.ts`).
// ---------------------------------------------------------------------------

function resolveWorkspaceRoot(cwd: string): string {
  const config = loadConfig(undefined, { env: process.env });
  const raw = config.runtime.workspace_root;
  return isAbsolute(raw) ? raw : resolve(cwd, raw);
}

function defaultDbPath(workspace: string): string {
  return process.env.AGENT_OS_DB ?? join(workspace, '.agent-os', 'agent-os.sqlite');
}

function evalRunsDir(workspace: string): string {
  return join(workspace, '.agent-os', 'eval-runs');
}

function evalRunSnapshotPath(workspace: string, runId: string): string {
  return join(evalRunsDir(workspace), `${runId}.json`);
}

// ---------------------------------------------------------------------------
// Provider id helpers.
// ---------------------------------------------------------------------------

function isProviderId(value: string): value is ProviderId {
  return value === 'claude_code_local' || value === 'anthropic_api' || value === 'openai_api';
}

// ---------------------------------------------------------------------------
// `eval run`
// ---------------------------------------------------------------------------

interface EvalRunCliOptions {
  json?: boolean;
  provider?: string;
  model?: string;
  enableModelGraded?: boolean;
}

/**
 * Build a `RunAgentFn` that drives the existing Provider pipeline.
 *
 * For each (agentId, prompt) tuple this:
 *   1. Looks the agent up in the workspace's `agents/` directory.
 *   2. Resolves the provider (CLI flag > agent frontmatter).
 *   3. Iterates the provider's stream, concatenating assistant message text.
 *   4. Throws if the run did not complete cleanly so the assertion layer can
 *      treat the case as a failure.
 */
async function buildRunAgentFn(
  workspaceRoot: string,
  options: EvalRunCliOptions,
): Promise<RunAgentFn> {
  const agentsDir = join(workspaceRoot, 'agents');
  const defs = await loadAgents(agentsDir);
  const byId = new Map<string, AgentDefinition>();
  for (const d of defs) byId.set(d.frontmatter.id, d);

  return async ({ agentId, prompt }) => {
    const def = byId.get(agentId);
    if (!def) {
      throw new Error(`eval run: agent "${agentId}" not found in ${agentsDir}`);
    }

    const providerIdRaw = options.provider ?? def.frontmatter.provider;
    if (!isProviderId(providerIdRaw)) {
      throw new Error(`eval run: unknown provider "${providerIdRaw}"`);
    }
    const providerId: ProviderId = providerIdRaw;

    if (!hasProvider(providerId)) {
      const config = loadConfig(undefined, { env: process.env });
      await ensureBuiltinProvidersRegistered(config as unknown as Record<string, unknown>);
    }
    const provider = getProvider(providerId);

    const input: AgentRunInput = {
      agentId: def.frontmatter.id,
      goal: prompt,
      instructions: def.body,
      workspaceRoot,
      allowedTools: def.frontmatter.tools.allowed,
      approvalRequiredTools: def.frontmatter.tools.approval_required,
      ...(options.model !== undefined
        ? { model: options.model }
        : def.frontmatter.model !== undefined
          ? { model: def.frontmatter.model }
          : {}),
    };

    const chunks: string[] = [];
    let sawError = false;
    let errorMessage = '';
    let doneReason: 'completed' | 'cancelled' | 'error' | null = null;

    for await (const event of provider.run(input)) {
      if (event.type === 'message' && event.role === 'assistant') {
        chunks.push(event.text);
      } else if (event.type === 'error') {
        sawError = true;
        errorMessage = event.message;
      } else if (event.type === 'done') {
        doneReason = event.reason;
        break;
      }
    }

    if (doneReason !== 'completed' || sawError) {
      const reason = sawError ? errorMessage : (doneReason ?? 'no done event');
      throw new Error(`agent "${agentId}" did not complete cleanly: ${reason}`);
    }

    return chunks.join('\n');
  };
}

/**
 * Best-effort `llm-rubric` grader. Builds a short rubric prompt and runs it
 * through the configured API-backed provider. When no provider is enabled or
 * the matching env key is missing, we return `null` so the runner cleanly
 * skips model-graded assertions.
 */
async function buildLlmRubricGrader(workspaceRoot: string): Promise<LlmRubricGrader | null> {
  const config = loadConfig(undefined, { env: process.env });

  // Pick the first enabled API-backed provider whose env key is set.
  const candidates: Array<{ id: ProviderId; envKey: string }> = [];
  if (config.providers.anthropic_api.enabled) {
    candidates.push({ id: 'anthropic_api', envKey: config.providers.anthropic_api.api_key_env });
  }
  if (config.providers.openai_api.enabled) {
    candidates.push({ id: 'openai_api', envKey: config.providers.openai_api.api_key_env });
  }
  const chosen = candidates.find((c) => Boolean(process.env[c.envKey]));
  if (!chosen) {
    process.stderr.write(
      'agent-os eval: --enable-model-graded set but no API-backed provider is configured with its env key; skipping llm-rubric assertions.\n',
    );
    return null;
  }

  if (!hasProvider(chosen.id)) {
    await ensureBuiltinProvidersRegistered(config as unknown as Record<string, unknown>);
  }
  let provider;
  try {
    provider = getProvider(chosen.id);
  } catch {
    process.stderr.write(
      `agent-os eval: provider "${chosen.id}" is enabled but its adapter is not registered; skipping llm-rubric assertions.\n`,
    );
    return null;
  }

  return async ({ output, rubric }) => {
    const instructions =
      'You are an evaluation grader. Decide whether the OUTPUT satisfies the RUBRIC. Reply with strictly the JSON object {"passed": true|false, "reason": "<one short sentence>"} and nothing else.';
    const goal = `RUBRIC:\n${rubric}\n\nOUTPUT:\n${output}`;
    const input: AgentRunInput = {
      agentId: 'llm-rubric-grader',
      goal,
      instructions,
      workspaceRoot,
    };

    const chunks: string[] = [];
    for await (const event of provider.run(input)) {
      if (event.type === 'message' && event.role === 'assistant') {
        chunks.push(event.text);
      } else if (event.type === 'done') {
        break;
      }
    }
    const text = chunks.join('\n').trim();

    // Pull the first JSON object out of the text.
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(text.slice(start, end + 1)) as {
          passed?: unknown;
          reason?: unknown;
        };
        const passed = parsed.passed === true;
        const reason = typeof parsed.reason === 'string' ? parsed.reason : undefined;
        return reason !== undefined ? { passed, reason } : { passed };
      } catch {
        // fall through
      }
    }
    return { passed: false, reason: `grader returned unparseable output: ${text.slice(0, 200)}` };
  };
}

/**
 * Persist every `FixtureResult` in the report to the `eval_results` table in
 * a single transaction.
 */
function persistResults(db: AgentOsDb, report: EvalRunReport): void {
  const now = new Date();
  const rows = report.fixtures.map((f) => ({
    id: randomUUID().replace(/-/g, ''),
    fixtureId: f.fixtureId,
    runId: null,
    score: Math.round(f.score * 100),
    passed: f.passed,
    detailsRef: JSON.stringify(f),
    createdAt: now,
  }));
  if (rows.length === 0) return;
  db.transaction((tx) => {
    for (const row of rows) {
      tx.insert(evalResults).values(row).run();
    }
  });
}

function writeReportSnapshot(workspaceRoot: string, report: EvalRunReport): string {
  const dir = evalRunsDir(workspaceRoot);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = evalRunSnapshotPath(workspaceRoot, report.runId);
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n', 'utf8');
  return path;
}

function formatRunSummary(report: EvalRunReport): string {
  const lines: string[] = [];
  let passedCount = 0;
  let failedCount = 0;
  for (const f of report.fixtures) {
    const status = f.passed ? 'PASS' : 'FAIL';
    if (f.passed) passedCount += 1;
    else failedCount += 1;
    const totalCases = f.cases.length;
    const passedCases = f.cases.filter((c) => c.passed).length;
    lines.push(
      `${status} ${f.fixtureId}  score=${f.score.toFixed(2)}  cases=${passedCases}/${totalCases}`,
    );
  }
  lines.push(`Run ${report.runId}: ${passedCount} passed, ${failedCount} failed`);
  return lines.join('\n') + '\n';
}

async function runEvalRun(
  cwd: string,
  target: string | undefined,
  options: EvalRunCliOptions,
): Promise<void> {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const resolvedTarget = target ?? join(workspaceRoot, 'evals', 'fixtures');

  const runAgent = await buildRunAgentFn(workspaceRoot, options);
  const llmRubricGrader =
    options.enableModelGraded === true ? await buildLlmRubricGrader(workspaceRoot) : null;

  const report = await runEvals(resolvedTarget, { runAgent, llmRubricGrader });

  // Persist to SQLite (best-effort: the snapshot is the source of truth for diff).
  const dbPath = defaultDbPath(workspaceRoot);
  const dbDir = join(workspaceRoot, '.agent-os');
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
  const db = openDatabase(dbPath);
  try {
    await runMigrations(db, { log: () => undefined });
    persistResults(db, report);
  } finally {
    db.$sqlite.close();
  }

  writeReportSnapshot(workspaceRoot, report);

  if (options.json === true) {
    process.stdout.write(JSON.stringify(report) + '\n');
  } else {
    process.stdout.write(formatRunSummary(report));
  }

  // CI-friendly exit code via `process.exitCode` — keeps `buildProgram` harnesses happy.
  if (!report.passed) {
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// `eval diff`
// ---------------------------------------------------------------------------

interface EvalDiffCliOptions {
  json?: boolean;
}

type DiffStatus = 'unchanged' | 'regressed' | 'recovered' | 'changed' | 'added' | 'removed';

interface DiffRow {
  fixtureId: string;
  a: { passed: boolean; score: number } | null;
  b: { passed: boolean; score: number } | null;
  status: DiffStatus;
  deltaScore: number;
}

function loadSnapshot(workspaceRoot: string, runId: string): EvalRunReport | null {
  const p = evalRunSnapshotPath(workspaceRoot, runId);
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, 'utf8');
  return JSON.parse(raw) as EvalRunReport;
}

function indexFixtures(report: EvalRunReport): Map<string, FixtureResult> {
  const out = new Map<string, FixtureResult>();
  for (const f of report.fixtures) out.set(f.fixtureId, f);
  return out;
}

function classify(
  a: FixtureResult | undefined,
  b: FixtureResult | undefined,
): { status: DiffStatus; deltaScore: number } {
  if (a && b) {
    const delta = b.score - a.score;
    if (a.passed && b.passed && Math.abs(delta) < 1e-6) {
      return { status: 'unchanged', deltaScore: delta };
    }
    if (a.passed && !b.passed) return { status: 'regressed', deltaScore: delta };
    if (!a.passed && b.passed) return { status: 'recovered', deltaScore: delta };
    return { status: 'changed', deltaScore: delta };
  }
  if (b && !a) return { status: 'added', deltaScore: b.score };
  if (a && !b) return { status: 'removed', deltaScore: -a.score };
  return { status: 'unchanged', deltaScore: 0 };
}

function diffReports(a: EvalRunReport, b: EvalRunReport): DiffRow[] {
  const aById = indexFixtures(a);
  const bById = indexFixtures(b);
  const allIds = new Set<string>([...aById.keys(), ...bById.keys()]);
  const rows: DiffRow[] = [];
  for (const id of [...allIds].sort()) {
    const fa = aById.get(id);
    const fb = bById.get(id);
    const { status, deltaScore } = classify(fa, fb);
    rows.push({
      fixtureId: id,
      a: fa ? { passed: fa.passed, score: fa.score } : null,
      b: fb ? { passed: fb.passed, score: fb.score } : null,
      status,
      deltaScore,
    });
  }
  return rows;
}

function formatDiffTable(rows: readonly DiffRow[]): string {
  const filtered = rows.filter((r) => r.status !== 'unchanged');
  if (filtered.length === 0) return 'no differences\n';
  const headers = ['FIXTURE', 'STATUS', 'A', 'B', 'ΔSCORE'];
  const cells: string[][] = [headers.slice()];
  for (const r of filtered) {
    const fmtSide = (s: { passed: boolean; score: number } | null): string =>
      s === null ? '—' : `${s.passed ? 'pass' : 'fail'} ${s.score.toFixed(2)}`;
    cells.push([
      r.fixtureId,
      r.status,
      fmtSide(r.a),
      fmtSide(r.b),
      (r.deltaScore >= 0 ? '+' : '') + r.deltaScore.toFixed(2),
    ]);
  }
  const widths = headers.map((_, col) => Math.max(...cells.map((row) => (row[col] ?? '').length)));
  return (
    cells
      .map((row) => row.map((c, i) => (i === row.length - 1 ? c : c.padEnd(widths[i]!))).join('  '))
      .join('\n') + '\n'
  );
}

async function runEvalDiff(
  cwd: string,
  runAId: string,
  runBId: string,
  options: EvalDiffCliOptions,
): Promise<void> {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const a = loadSnapshot(workspaceRoot, runAId);
  if (!a) {
    process.stderr.write(
      `agent-os eval diff: snapshot not found for run "${runAId}" (${evalRunSnapshotPath(
        workspaceRoot,
        runAId,
      )})\n`,
    );
    process.exitCode = 1;
    return;
  }
  const b = loadSnapshot(workspaceRoot, runBId);
  if (!b) {
    process.stderr.write(
      `agent-os eval diff: snapshot not found for run "${runBId}" (${evalRunSnapshotPath(
        workspaceRoot,
        runBId,
      )})\n`,
    );
    process.exitCode = 1;
    return;
  }

  const rows = diffReports(a, b);
  const hasRegression = rows.some((r) => r.status === 'regressed');

  if (options.json === true) {
    process.stdout.write(
      JSON.stringify({
        runA: a.runId,
        runB: b.runId,
        fixtures: rows,
      }) + '\n',
    );
  } else {
    process.stdout.write(formatDiffTable(rows));
  }

  if (hasRegression) {
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Command wiring
// ---------------------------------------------------------------------------

function withErrorReporting(fn: () => Promise<void>, label: string): () => Promise<void> {
  return async () => {
    try {
      await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`agent-os ${label}: ${message}\n`);
      process.exitCode = 1;
    }
  };
}

export function buildEvalCommand(): Command {
  const cmd = new Command('eval').description(
    'Run evaluation fixtures and diff persisted run reports',
  );

  cmd
    .command('run [target]')
    .description(
      'Run eval fixtures (default: <workspaceRoot>/evals/fixtures); persists results to eval_results',
    )
    .option('--json', 'Emit the full EvalRunReport as JSON', false)
    .option('--provider <id>', 'Override the provider for the underlying agent run')
    .option('--model <name>', "Override the agent's default model")
    .option(
      '--enable-model-graded',
      'Run llm-rubric assertions (requires an API-backed provider)',
      false,
    )
    .action((target: string | undefined, options: EvalRunCliOptions) =>
      withErrorReporting(() => runEvalRun(process.cwd(), target, options), 'eval run')(),
    );

  cmd
    .command('diff <run-a> <run-b>')
    .description('Diff two persisted eval-run snapshots from .agent-os/eval-runs/')
    .option('--json', 'Emit a machine-readable JSON diff', false)
    .action((runA: string, runB: string, options: EvalDiffCliOptions) =>
      withErrorReporting(() => runEvalDiff(process.cwd(), runA, runB, options), 'eval diff')(),
    );

  return cmd;
}
