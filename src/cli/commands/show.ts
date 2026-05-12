/**
 * `agent-os show <run-id>` — Phase 8 observability surface.
 *
 * Naming divergence from PRD: the PRD literally says `agent-os run show
 * <run-id>`, but `agent-os run` is a leaf command (`run <agent-id>
 * <goal...>`) and converting it into a Commander group would break the
 * existing surface. We therefore expose this as a top-level `agent-os show
 * <run-id>` command which works for ANY run id (agent run or workflow run)
 * since both write into the same `runs` table.
 *
 * Behaviour:
 *   1. Load the `runs` row by id; if missing, exit 1.
 *   2. Load `steps` for the run (chronological by started_at).
 *   3. Load `tool_calls` joined to those steps.
 *   4. Load `traces` rows for the run; parse each `otel_span_json` and rebuild
 *      the parent → children tree via `context.parentSpanId`.
 *   5. Render: a header, then the span tree (unicode), then the per-step
 *      table, then any pending approvals.
 *
 * Graceful degradation: token / cost rendering uses `formatNullableNumber`
 * from `src/core/observability/index.ts` so missing usage shows as `"—"`
 * rather than fabricated zeros (Max-mode local provider).
 *
 * When `observability.traces=false` (or simply no spans recorded for the
 * run), the trace tree is replaced with a one-line hint and the rest of the
 * report renders normally.
 *
 * Local-first: reads only from the workspace SQLite DB. No environment
 * variables, no network, no provider plumbing.
 */

import { resolve, isAbsolute, join } from 'node:path';
import { Command } from 'commander';
import { and, eq, inArray } from 'drizzle-orm';

import { loadConfig } from '../../config/index.js';
import { openDatabase, type AgentOsDb } from '../../storage/db.js';
import { runMigrations } from '../../storage/migrate.js';
import { approvals, runs, steps, toolCalls, traces } from '../../storage/schema.js';
import {
  formatNullableNumber,
  type AttributeValue,
  type SpanKind,
  type SpanRecord,
  type SpanStatus,
} from '../../core/observability/index.js';

// ---------------------------------------------------------------------------
// Workspace / DB helpers — mirror workflow.ts conventions exactly.
// ---------------------------------------------------------------------------

function resolveWorkspaceRoot(cwd: string): string {
  const config = loadConfig(undefined, { env: process.env });
  const raw = config.runtime.workspace_root;
  return isAbsolute(raw) ? raw : resolve(cwd, raw);
}

function defaultDbPath(workspace: string): string {
  return process.env.AGENT_OS_DB ?? join(workspace, '.agent-os', 'db.sqlite');
}

async function openWorkspaceDb(workspace: string): Promise<AgentOsDb> {
  const dbPath = defaultDbPath(workspace);
  const db = openDatabase(dbPath);
  try {
    await runMigrations(db, { log: () => undefined });
  } catch (err) {
    db.$sqlite.close();
    throw err;
  }
  return db;
}

function toEpochMs(value: Date | null | undefined): number | null {
  if (value == null) return null;
  if (value instanceof Date) return value.getTime();
  return Number(value);
}

// ---------------------------------------------------------------------------
// Duration formatting
// ---------------------------------------------------------------------------

function formatDuration(ms: number | null): string {
  if (ms === null || Number.isNaN(ms) || ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  const totalSec = Math.floor(ms / 1000);
  const remMs = ms % 1000;
  if (totalSec < 60) {
    return remMs === 0
      ? `${totalSec}s`
      : `${totalSec}.${String(remMs).padStart(3, '0').slice(0, 1)}s`;
  }
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec === 0 ? `${min}m` : `${min}m ${sec}s`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin === 0 ? `${hr}h` : `${hr}h ${remMin}m`;
}

// ---------------------------------------------------------------------------
// Persisted span envelope (matches `spanToPersistedJson`)
// ---------------------------------------------------------------------------

interface PersistedSpan {
  context: { traceId: string; spanId: string; parentSpanId?: string; runId: string };
  kind: SpanKind;
  name: string;
  startTimeMs: number;
  endTimeMs: number | null;
  status: SpanStatus;
  attributes: Record<string, AttributeValue>;
  events: SpanRecord['events'];
  links: SpanRecord['links'];
}

interface SpanNode extends PersistedSpan {
  children: SpanNode[];
}

function parseSpan(json: string): PersistedSpan | null {
  try {
    const obj = JSON.parse(json) as PersistedSpan;
    if (
      typeof obj !== 'object' ||
      obj === null ||
      typeof obj.context !== 'object' ||
      typeof obj.context.spanId !== 'string'
    ) {
      return null;
    }
    return obj;
  } catch {
    return null;
  }
}

function buildSpanTree(rows: { otelSpanJson: string }[]): SpanNode[] {
  const spans = rows
    .map((r) => parseSpan(r.otelSpanJson))
    .filter((s): s is PersistedSpan => s !== null);
  const bySpanId = new Map<string, SpanNode>();
  for (const s of spans) {
    bySpanId.set(s.context.spanId, { ...s, children: [] });
  }
  const roots: SpanNode[] = [];
  for (const node of bySpanId.values()) {
    const parentId = node.context.parentSpanId;
    if (parentId !== undefined && bySpanId.has(parentId)) {
      bySpanId.get(parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  // Stable: chronological by startTimeMs at every level.
  const sortRec = (nodes: SpanNode[]): void => {
    nodes.sort((a, b) => a.startTimeMs - b.startTimeMs);
    for (const n of nodes) sortRec(n.children);
  };
  sortRec(roots);
  return roots;
}

// ---------------------------------------------------------------------------
// Pretty rendering
// ---------------------------------------------------------------------------

const KIND_GLYPH: Record<SpanKind, string> = {
  workflow: '⚙',
  agent: '🤖',
  tool_call: '🔧',
  retrieval: '🔎',
};

interface AnsiOptions {
  color: boolean;
}

function colorize(s: string, code: string, opts: AnsiOptions): string {
  if (!opts.color) return s;
  return `[${code}m${s}[0m`;
}

function statusColor(status: SpanStatus): string {
  switch (status) {
    case 'ok':
      return '32'; // green
    case 'error':
      return '31'; // red
    case 'cancelled':
      return '33'; // yellow
    default:
      return '90'; // bright black
  }
}

function statusLabel(status: SpanStatus): string {
  switch (status) {
    case 'ok':
      return 'ok';
    case 'error':
      return 'error';
    case 'cancelled':
      return 'cancelled';
    case 'unset':
      return 'unset';
  }
}

function getNumberAttr(attrs: Record<string, AttributeValue>, key: string): number | null {
  const v = attrs[key];
  if (typeof v === 'number') return v;
  return null;
}

function getStringAttr(attrs: Record<string, AttributeValue>, key: string): string | null {
  const v = attrs[key];
  if (typeof v === 'string') return v;
  return null;
}

function renderSpanLine(
  node: SpanNode,
  prefix: string,
  isLast: boolean,
  opts: AnsiOptions,
): string {
  const branch = prefix === '' ? '' : isLast ? '└─ ' : '├─ ';
  const glyph = KIND_GLYPH[node.kind] ?? '•';
  const label = `${glyph} ${node.kind}:${node.name}`;
  const duration =
    node.endTimeMs !== null && node.endTimeMs !== undefined
      ? formatDuration(node.endTimeMs - node.startTimeMs)
      : '—';
  const status = colorize(statusLabel(node.status), statusColor(node.status), opts);

  const extras: string[] = [];
  if (node.kind === 'agent') {
    const costUsd = getNumberAttr(node.attributes, 'gen_ai.usage.cost_usd');
    const inTok = getNumberAttr(node.attributes, 'gen_ai.usage.input_tokens');
    const outTok = getNumberAttr(node.attributes, 'gen_ai.usage.output_tokens');
    const cost =
      costUsd === null ? '—' : `$${formatNullableNumber(costUsd, { fractionDigits: 4 })}`;
    const tokens =
      inTok === null && outTok === null
        ? '—'
        : `in:${formatNullableNumber(inTok)} out:${formatNullableNumber(outTok)}`;
    extras.push(`cost=${cost}`);
    extras.push(`tokens=${tokens}`);
  } else if (node.kind === 'tool_call') {
    const risk = getStringAttr(node.attributes, 'tool.risk');
    if (risk) extras.push(`risk=${risk}`);
  } else if (node.kind === 'retrieval') {
    const scope = getStringAttr(node.attributes, 'memory.scope');
    if (scope) extras.push(`scope=${scope}`);
  }

  const tail = extras.length > 0 ? '    ' + extras.join('  ') : '';
  return `${prefix}${branch}${label}  ${duration}  ${status}${tail}`;
}

function renderSpanTree(roots: SpanNode[], opts: AnsiOptions): string[] {
  const lines: string[] = [];
  const walk = (node: SpanNode, prefix: string, isLast: boolean, depth: number): void => {
    lines.push(renderSpanLine(node, prefix, isLast, opts));
    const childPrefix = depth === 0 ? '' : prefix + (isLast ? '    ' : '│   ');
    const nextPrefix = childPrefix === '' ? '    ' : childPrefix;
    node.children.forEach((c, i) => {
      walk(c, nextPrefix, i === node.children.length - 1, depth + 1);
    });
  };
  roots.forEach((r, i) => walk(r, '', i === roots.length - 1, 0));
  return lines;
}

// ---------------------------------------------------------------------------
// Typed payload (--json)
// ---------------------------------------------------------------------------

interface ShowJsonStep {
  id: string;
  kind: string;
  name: string;
  status: string;
  started_at: number | null;
  ended_at: number | null;
  duration_ms: number | null;
  error: string | null;
}

interface ShowJsonToolCall {
  id: string;
  step_id: string;
  tool: string;
  risk: string;
  status: string;
  latency_ms: number | null;
  approved_by: string | null;
}

interface ShowJsonApproval {
  id: string;
  step_id: string | null;
  status: string;
  action: string;
}

interface ShowJsonRun {
  id: string;
  workflow_id: string | null;
  agent_id: string;
  status: string;
  started_at: number | null;
  ended_at: number | null;
  duration_ms: number | null;
  provider: string;
  model: string;
  summary: string | null;
}

interface ShowJsonPayload {
  run: ShowJsonRun;
  steps: ShowJsonStep[];
  toolCalls: ShowJsonToolCall[];
  approvalsPending: ShowJsonApproval[];
  traces: PersistedSpan[];
}

// ---------------------------------------------------------------------------
// Command implementation
// ---------------------------------------------------------------------------

interface ShowCliOptions {
  json?: boolean;
  color?: boolean;
  spans?: boolean;
}

export async function showRunCommand(
  cwd: string,
  runId: string,
  opts: ShowCliOptions,
): Promise<number> {
  const workspace = resolveWorkspaceRoot(cwd);
  const db = await openWorkspaceDb(workspace);
  try {
    const runRows = await db.select().from(runs).where(eq(runs.id, runId));
    if (runRows.length === 0) {
      process.stderr.write(`agent-os show: run "${runId}" not found\n`);
      return 1;
    }
    const r = runRows[0]!;
    const started = toEpochMs(r.startedAt);
    const ended = toEpochMs(r.endedAt);
    const durationMs = started !== null && ended !== null ? ended - started : null;

    const stepRows = await db.select().from(steps).where(eq(steps.runId, runId));
    const stepsOut: ShowJsonStep[] = stepRows
      .map((s) => {
        const sStarted = toEpochMs(s.startedAt);
        const sEnded = toEpochMs(s.endedAt);
        return {
          id: s.id,
          kind: s.kind,
          name: s.name,
          status: s.status,
          started_at: sStarted,
          ended_at: sEnded,
          duration_ms: sStarted !== null && sEnded !== null ? sEnded - sStarted : null,
          error: s.error,
        };
      })
      .sort((a, b) => (a.started_at ?? 0) - (b.started_at ?? 0));

    let toolCallRows: ShowJsonToolCall[] = [];
    if (stepRows.length > 0) {
      const stepIds = stepRows.map((s) => s.id);
      const rows = await db.select().from(toolCalls).where(inArray(toolCalls.stepId, stepIds));
      toolCallRows = rows.map((t) => ({
        id: t.id,
        step_id: t.stepId,
        tool: t.tool,
        risk: t.risk,
        status: t.status,
        latency_ms: t.latencyMs,
        approved_by: t.approvedBy,
      }));
    }

    const pendingApprovals = await db
      .select()
      .from(approvals)
      .where(and(eq(approvals.runId, runId), eq(approvals.status, 'pending')));
    const approvalsOut: ShowJsonApproval[] = pendingApprovals.map((a) => ({
      id: a.id,
      step_id: a.stepId,
      status: a.status,
      action: a.action,
    }));

    const includeSpans = opts.spans !== false;
    let spanRoots: SpanNode[] = [];
    let traceJson: PersistedSpan[] = [];
    if (includeSpans) {
      const traceRows = await db
        .select({ otelSpanJson: traces.otelSpanJson })
        .from(traces)
        .where(eq(traces.runId, runId));
      spanRoots = buildSpanTree(traceRows);
      // Flatten for the JSON payload — preserve original PersistedSpan shape.
      const flatten = (nodes: SpanNode[]): PersistedSpan[] => {
        const out: PersistedSpan[] = [];
        const walk = (n: SpanNode): void => {
          const { children, ...rest } = n;
          out.push(rest);
          children.forEach(walk);
        };
        nodes.forEach(walk);
        return out;
      };
      traceJson = flatten(spanRoots);
    }

    const payload: ShowJsonPayload = {
      run: {
        id: r.id,
        workflow_id: r.workflowId,
        agent_id: r.agentId,
        status: r.status,
        started_at: started,
        ended_at: ended,
        duration_ms: durationMs,
        provider: r.provider,
        model: r.model,
        summary: r.summary,
      },
      steps: stepsOut,
      toolCalls: toolCallRows,
      approvalsPending: approvalsOut,
      traces: traceJson,
    };

    if (opts.json) {
      process.stdout.write(JSON.stringify(payload) + '\n');
      return 0;
    }

    // Pretty rendering.
    const wantColor = opts.color !== false && process.stdout.isTTY === true;
    const ansi: AnsiOptions = { color: wantColor };

    const lines: string[] = [];
    const header = `Run ${payload.run.id}  workflow=${payload.run.workflow_id ?? '(none)'}  agent=${payload.run.agent_id}  status=${payload.run.status}`;
    lines.push(header);
    lines.push(
      `  Started ${started !== null ? new Date(started).toISOString() : '—'}  ended ${ended !== null ? new Date(ended).toISOString() : '—'}  duration ${formatDuration(durationMs)}`,
    );
    lines.push(`  provider=${payload.run.provider}  model=${payload.run.model}`);
    if (payload.run.summary) lines.push(`  summary: ${payload.run.summary}`);

    if (includeSpans) {
      lines.push('');
      if (spanRoots.length === 0) {
        lines.push('  no spans recorded — set observability.traces=true to capture them');
      } else {
        renderSpanTree(spanRoots, ansi).forEach((l) => lines.push('  ' + l));
      }
    }

    lines.push('');
    if (stepsOut.length === 0) {
      lines.push(`  steps: (none)`);
    } else {
      lines.push(`  steps (${stepsOut.length} written rows):`);
      for (const s of stepsOut) {
        const dur = formatDuration(s.duration_ms);
        const err = s.error ? `  ${s.error}` : '';
        lines.push(`  - ${s.id}  ${s.kind}  ${s.name}  ${s.status}  ${dur}${err}`);
      }
    }

    lines.push('');
    if (approvalsOut.length === 0) {
      lines.push('  approvals: none pending');
    } else {
      lines.push(`  approvals (${approvalsOut.length} pending):`);
      for (const a of approvalsOut) {
        lines.push(`  - ${a.id}  step=${a.step_id ?? '—'}  action=${a.action}`);
      }
    }

    process.stdout.write(lines.join('\n') + '\n');
    return 0;
  } finally {
    db.$sqlite.close();
  }
}

// ---------------------------------------------------------------------------
// Command wiring
// ---------------------------------------------------------------------------

export function buildShowCommand(): Command {
  const cmd = new Command('show')
    .description(
      'Render the timeline of a run (agent or workflow) including spans, steps and pending approvals',
    )
    .argument('<run-id>', 'Run id to show')
    .option('--json', 'Emit a machine-readable JSON payload', false)
    .option('--no-color', 'Disable ANSI colour output')
    .option('--no-spans', 'Skip the trace tree (useful when observability.traces=false)')
    .action(async (runId: string, options: ShowCliOptions) => {
      let code: number;
      try {
        code = await showRunCommand(process.cwd(), runId, options);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`agent-os show: ${message}\n`);
        code = 1;
      }
      if (code !== 0) process.exit(code);
    });
  return cmd;
}
