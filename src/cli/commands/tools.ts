/**
 * `agent-os tools` command group: lists the in-process tool registry and
 * dry-runs the interceptor's policy decision for a given tool id.
 *
 * Read-only: this command NEVER actually invokes a tool. `tools test` is a
 * diagnostic that surfaces the verdict (`allow | approval_required | deny |
 * unknown`) the runtime would make against the workspace's security config
 * and the agent's tool policy.
 *
 * Canonical reference: PRD §2.5 (policy engine), PRD §1.7 (risk tags),
 * PRD Phase 10 (CLI developer interface).
 */

import { isAbsolute, join, resolve } from 'node:path';
import { Command } from 'commander';

import { loadConfig } from '../../config/index.js';
import { loadAgents, type AgentDefinition } from '../../core/agents/loader.js';
import { createToolRegistry, type ToolDescriptor } from '../../core/tools/registry.js';
import { classifyTool } from '../../core/tools/risk.js';
import { evaluate, type PolicyDecision } from '../../core/tools/policy.js';

// ---------------------------------------------------------------------------
// Shared helpers (kept local — these are tiny enough not to warrant their own
// module, and `agent.ts` has its own copies for the same reason).
// ---------------------------------------------------------------------------

function resolveWorkspaceRoot(cwd: string): string {
  const config = loadConfig(undefined, { env: process.env });
  const raw = config.runtime.workspace_root;
  return isAbsolute(raw) ? raw : resolve(cwd, raw);
}

/** Render a left-aligned column report. Single-space gutter; no borders. */
function formatTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((h, col) => {
    let w = h.length;
    for (const row of rows) {
      const cell = row[col] ?? '';
      if (cell.length > w) w = cell.length;
    }
    return w;
  });
  const pad = (cells: readonly string[]) =>
    cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!))).join('  ');
  const lines: string[] = [pad(headers)];
  for (const row of rows) lines.push(pad(row));
  return lines.join('\n') + '\n';
}

function withErrorReporting(fn: () => Promise<void>, label: string): () => Promise<void> {
  return async () => {
    try {
      await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`agent-os ${label}: ${message}\n`);
      process.exit(1);
    }
  };
}

// ---------------------------------------------------------------------------
// `tools list`
// ---------------------------------------------------------------------------

interface ListToolRow {
  id: string;
  risk: ToolDescriptor['risk'];
  source: string;
  description?: string;
}

interface ListCliOptions {
  json?: boolean;
  agent?: string;
}

/** Build the union of (builtin registry, optionally agent-specific tools). */
async function collectTools(cwd: string, agentId?: string): Promise<ListToolRow[]> {
  const registry = createToolRegistry();
  const builtinIds = new Set(registry.list().map((t) => t.id));

  let agent: AgentDefinition | undefined;
  if (agentId !== undefined) {
    const workspace = resolveWorkspaceRoot(cwd);
    const defs = await loadAgents(join(workspace, 'agents'));
    agent = defs.find((d) => d.frontmatter.id === agentId);
    if (!agent) {
      throw new Error(`agent "${agentId}" not found`);
    }
    const agentTools = [
      ...agent.frontmatter.tools.allowed,
      ...agent.frontmatter.tools.approval_required,
    ];
    for (const id of agentTools) {
      if (!registry.has(id)) {
        registry.register({ id, risk: classifyTool(id) });
      }
    }
  }

  const rows: ListToolRow[] = registry.list().map((tool) => ({
    id: tool.id,
    risk: tool.risk,
    source: builtinIds.has(tool.id)
      ? 'builtin'
      : agent
        ? `agent:${agent.frontmatter.id}`
        : 'builtin',
    ...(tool.description !== undefined ? { description: tool.description } : {}),
  }));

  rows.sort((a, b) => {
    if (a.source !== b.source) return a.source < b.source ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return rows;
}

async function runToolsList(cwd: string, opts: ListCliOptions): Promise<void> {
  const rows = await collectTools(cwd, opts.agent);

  if (opts.json) {
    process.stdout.write(JSON.stringify(rows) + '\n');
    return;
  }

  if (rows.length === 0) {
    process.stdout.write('No tools registered.\n');
    return;
  }

  const tableRows = rows.map((r) => [r.id, r.risk, r.source, r.description ?? '']);
  process.stdout.write(formatTable(['TOOL', 'RISK', 'SOURCE', 'DESCRIPTION'], tableRows));
}

// ---------------------------------------------------------------------------
// `tools test <tool-id>`
// ---------------------------------------------------------------------------

interface TestCliOptions {
  json?: boolean;
  args?: string;
  agent?: string;
  autoApprove?: boolean;
}

type Verdict = 'allow' | 'approval_required' | 'deny' | 'unknown';

interface TestReport {
  tool: string;
  risk: PolicyDecision['risk'];
  source: string;
  verdict: Verdict;
  reason: string;
}

function parseArgs(raw: string | undefined): unknown {
  if (raw === undefined || raw.length === 0) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`--args is not valid JSON: ${message}`);
  }
}

async function runToolsTest(cwd: string, toolId: string, opts: TestCliOptions): Promise<void> {
  const args = parseArgs(opts.args);
  const config = loadConfig(undefined, { env: process.env });

  const registry = createToolRegistry();
  const builtinIds = new Set(registry.list().map((t) => t.id));

  let agent: AgentDefinition | undefined;
  if (opts.agent !== undefined) {
    const workspace = resolveWorkspaceRoot(cwd);
    const defs = await loadAgents(join(workspace, 'agents'));
    agent = defs.find((d) => d.frontmatter.id === opts.agent);
    if (!agent) {
      throw new Error(`agent "${opts.agent}" not found`);
    }
    for (const id of [
      ...agent.frontmatter.tools.allowed,
      ...agent.frontmatter.tools.approval_required,
    ]) {
      if (!registry.has(id)) {
        registry.register({ id, risk: classifyTool(id) });
      }
    }
  }

  const known = registry.has(toolId) || agent !== undefined;
  if (!registry.has(toolId) && agent === undefined) {
    // Tool id is unknown AND no agent provides it — exit 1.
    const report: TestReport = {
      tool: toolId,
      risk: classifyTool(toolId),
      source: 'unknown',
      verdict: 'unknown',
      reason: 'tool id is not in the registry and no --agent was provided',
    };
    if (opts.json) {
      process.stdout.write(JSON.stringify(report) + '\n');
    } else {
      writeTestReport(report);
    }
    process.exit(1);
    return;
  }

  // Decide source for reporting purposes.
  let source: string;
  if (builtinIds.has(toolId)) {
    source = 'builtin';
  } else if (agent !== undefined) {
    source = `agent:${agent.frontmatter.id}`;
  } else {
    source = 'builtin';
  }

  // Build an agent shape for the policy engine. When no `--agent` was given we
  // synthesise a "workspace registry" agent whose `tools.allowed` is the full
  // built-in registry — this surfaces the risk-class verdict (e.g. fs.read =
  // allow, shell.exec = approval_required) instead of always reporting `deny`
  // due to the workspace's `default_tool_policy: deny` floor. Diagnostic only.
  const agentForPolicy = agent
    ? {
        id: agent.frontmatter.id,
        tools: agent.frontmatter.tools,
        permissions: agent.frontmatter.permissions,
      }
    : {
        id: '__cli_dryrun__',
        tools: {
          allowed: registry.list().map((t) => t.id),
          approval_required: [],
        },
        permissions: {
          network: 'allow' as const,
          file_read: 'allow' as const,
          file_write: 'allow' as const,
          shell: 'allow' as const,
        },
      };

  const decision = evaluate({
    tool: toolId,
    args,
    agent: agentForPolicy,
    security: config.security,
  });

  let verdict: Verdict = decision.outcome;
  let reason = decision.reason;

  if (verdict === 'approval_required' && opts.autoApprove) {
    // Simulate the approval pass.
    verdict = 'allow';
    reason = `${decision.reason} (auto-approved via --auto-approve)`;
  }

  const report: TestReport = {
    tool: toolId,
    risk: decision.risk,
    source,
    verdict,
    reason,
  };

  if (opts.json) {
    process.stdout.write(JSON.stringify(report) + '\n');
  } else {
    writeTestReport(report);
  }
  // Diagnostic — always exit 0 (the unknown-tool path above exits 1 earlier).
  void known;
}

function writeTestReport(report: TestReport): void {
  const lines: string[] = [
    `tool: ${report.tool}`,
    `risk: ${report.risk}`,
    `source: ${report.source}`,
    `verdict: ${report.verdict}`,
    `reason: ${report.reason}`,
  ];
  process.stdout.write(lines.join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// Command wiring
// ---------------------------------------------------------------------------

export function buildToolsCommand(): Command {
  const cmd = new Command('tools').description(
    'Inspect the tool registry and dry-run policy decisions',
  );

  cmd
    .command('list')
    .description('List tools known to the registry (built-ins + optional agent tools)')
    .option('--json', 'Emit a machine-readable JSON array', false)
    .option('--agent <id>', 'Merge the named agent’s tool allow/approval lists into the registry')
    .action((options: ListCliOptions) =>
      withErrorReporting(() => runToolsList(process.cwd(), options), 'tools list')(),
    );

  cmd
    .command('test <tool-id>')
    .description("Dry-run the policy engine's decision for the given tool id (no actual call)")
    .option('--json', 'Emit a machine-readable JSON object', false)
    .option('--args <json>', 'JSON-encoded call args (default: {})')
    .option('--agent <id>', 'Resolve via the named agent’s tool policy')
    .option('--auto-approve', 'Treat approval_required outcomes as approved', false)
    .action((toolId: string, options: TestCliOptions) =>
      withErrorReporting(() => runToolsTest(process.cwd(), toolId, options), 'tools test')(),
    );

  return cmd;
}
