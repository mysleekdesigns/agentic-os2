/**
 * `agent-os run <agent-id> <goal...>` — drives a single agent end-to-end
 * through the provider abstraction and streams the resulting transcript to
 * stdout.
 *
 * Wire-up:
 *   1. Load the workspace config + agent definitions from `<workspace>/agents/`.
 *   2. Resolve the provider (CLI flag wins; agent's `provider` field is the
 *      fallback) and call `ensureBuiltinProvidersRegistered` so Bundle B's
 *      `claude_code_local` adapter is wired up when present.
 *   3. Stream the provider's `RunEvent`s through the pure renderer in
 *      `../transcript.ts` (JSONL when `--json`, pretty otherwise).
 *   4. Translate the final `done` event into a conventional Unix exit code:
 *      completed → 0, cancelled → 130 (SIGINT), error → 1.
 *
 * No API key dependency: tests inject a `FakeProvider` via `registerProvider`,
 * so this command never reads `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` itself.
 *
 * Canonical reference: PRD §2.2 and PRD Phase 3.
 */

import { resolve, isAbsolute, join } from 'node:path';
import { Command } from 'commander';

import { loadConfig } from '../../config/index.js';
import { loadAgents } from '../../core/agents/loader.js';
import {
  ensureBuiltinProvidersRegistered,
  getProvider,
  hasProvider,
  type AgentRunInput,
  type ProviderId,
  type RunEvent,
} from '../../core/providers/index.js';
import {
  interceptProviderStream,
  type ApprovalResolver,
  type ToolAuditor,
} from '../../core/tools/interceptor.js';
import { createSqliteAuditor, type SqliteAuditor } from '../../core/tools/audit.js';
import { openDatabase, type AgentOsDb } from '../../storage/db.js';
import { runMigrations } from '../../storage/migrate.js';
import { createBlobStore } from '../../storage/blobs.js';
import { createTtyApprovalResolver } from '../approvals.js';
import { renderEvent, renderJsonLine } from '../transcript.js';

/** CLI flag bag for `agent-os run`. */
interface RunCliOptions {
  json?: boolean;
  model?: string;
  mcp?: boolean; // Commander turns `--no-mcp` into `mcp: false`.
  cwd?: string;
  provider?: string;
  color?: boolean; // Commander turns `--no-color` into `color: false`.
  audit?: boolean; // Commander turns `--no-audit` into `audit: false`.
  autoApprove?: boolean;
  /**
   * Phase 6: route approval_required tool calls through the persistent
   * approval queue (`approvals` table) instead of asking the inline resolver.
   * The first gated tool call causes the run to exit with a message pointing
   * the user at `agent-os approvals list`.
   */
  queueApprovals?: boolean;
}

/**
 * Optional injection hook for tests. Lets `runAgent` callers swap in a fake
 * auditor or approval resolver without exercising the real SQLite/TTY paths.
 */
export interface RunAgentInternals {
  auditorFactory?: (args: {
    workspaceRoot: string;
    agentId: string;
    provider: string;
    model: string;
    redactSecrets: boolean;
  }) => Promise<SqliteAuditor | ToolAuditor | null> | SqliteAuditor | ToolAuditor | null;
  approvalResolverFactory?: (options: RunCliOptions) => ApprovalResolver;
}

/** Final exit-code mapping for the `done` event's `reason` field. */
function exitCodeFor(reason: 'completed' | 'cancelled' | 'error'): number {
  switch (reason) {
    case 'completed':
      return 0;
    case 'cancelled':
      return 130; // POSIX convention for SIGINT-terminated processes.
    case 'error':
      return 1;
  }
}

/** Whether the supplied id is a recognised `ProviderId` (PRD §2.2). */
function isProviderId(value: string): value is ProviderId {
  return value === 'claude_code_local' || value === 'anthropic_api' || value === 'openai_api';
}

/** Resolve `<workspace_root>` the same way `agent.ts` does. */
function resolveWorkspaceRoot(cwd: string): string {
  const config = loadConfig(undefined, { env: process.env });
  const raw = config.runtime.workspace_root;
  return isAbsolute(raw) ? raw : resolve(cwd, raw);
}

/**
 * Pure, testable workhorse for the `run` command. Receives a workspace cwd and
 * parsed CLI options; returns the integer exit code. Side effects are confined
 * to stdout/stderr writes via the renderer.
 */
export async function runAgent(
  cwd: string,
  agentId: string,
  goalParts: readonly string[],
  options: RunCliOptions,
  internals: RunAgentInternals = {},
): Promise<number> {
  const goal = goalParts.join(' ').trim();
  if (goal.length === 0) {
    process.stderr.write('agent-os run: missing goal\n');
    return 1;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const agentsDir = join(workspaceRoot, 'agents');
  const defs = await loadAgents(agentsDir);
  const def = defs.find((d) => d.frontmatter.id === agentId);
  if (!def) {
    process.stderr.write(`agent-os: agent "${agentId}" not found\n`);
    return 1;
  }

  // Provider resolution: CLI flag wins, otherwise the agent's declared provider.
  const providerIdRaw = options.provider ?? def.frontmatter.provider;
  if (!isProviderId(providerIdRaw)) {
    process.stderr.write(`agent-os run: unknown provider "${providerIdRaw}"\n`);
    return 1;
  }
  const providerId: ProviderId = providerIdRaw;

  // Eagerly register the built-in provider adapter (Bundle B) only if no
  // factory is already registered for this id. This lets tests pre-register a
  // FakeProvider without it being overwritten, and is a safe no-op in
  // production where nothing pre-registers the adapter.
  if (!hasProvider(providerId)) {
    const config = loadConfig(undefined, { env: process.env });
    await ensureBuiltinProvidersRegistered(config as unknown as Record<string, unknown>);
  }

  let provider;
  try {
    provider = getProvider(providerId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`agent-os run: ${message}\n`);
    return 1;
  }

  // SIGINT → AbortController. We register only for the duration of the run so
  // we don't interfere with other commands sharing the process (tests).
  const controller = new AbortController();
  const onSigint = (): void => {
    controller.abort();
  };
  process.on('SIGINT', onSigint);

  // Output mode: JSONL suppresses colour entirely.
  const json = options.json === true;
  const color = json ? false : (options.color ?? process.stdout.isTTY === true);

  // Build the AgentRunInput. `mcpServers: undefined` lets the provider load
  // `.mcp.json` from disk; `--no-mcp` forces an empty bag.
  const input: AgentRunInput = {
    agentId: def.frontmatter.id,
    goal,
    instructions: def.body,
    workspaceRoot,
    signal: controller.signal,
    allowedTools: def.frontmatter.tools.allowed,
    approvalRequiredTools: def.frontmatter.tools.approval_required,
    ...(options.model !== undefined
      ? { model: options.model }
      : def.frontmatter.model !== undefined
        ? { model: def.frontmatter.model }
        : {}),
    ...(options.mcp === false ? { mcpServers: {} } : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
  };

  // Resolve security config + auditor + approval resolver before the loop.
  const config = loadConfig(undefined, { env: process.env });
  const auditEnabled = options.audit !== false;
  const providerName: string = providerId;
  const modelName: string = input.model ?? '';

  let auditor: SqliteAuditor | ToolAuditor | null = null;
  let auditorIsFinalizable = false;
  if (auditEnabled) {
    try {
      if (internals.auditorFactory) {
        auditor = await internals.auditorFactory({
          workspaceRoot,
          agentId: def.frontmatter.id,
          provider: providerName,
          model: modelName,
          redactSecrets: config.security.redact_secrets_in_logs,
        });
      } else {
        auditor = await defaultAuditorFactory({
          workspaceRoot,
          agentId: def.frontmatter.id,
          provider: providerName,
          model: modelName,
          redactSecrets: config.security.redact_secrets_in_logs,
        });
      }
      auditorIsFinalizable = auditor !== null && isSqliteAuditor(auditor);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`agent-os run: audit setup failed: ${message}\n`);
      auditor = null;
      auditorIsFinalizable = false;
    }
  }

  const approvalResolver: ApprovalResolver = internals.approvalResolverFactory
    ? internals.approvalResolverFactory(options)
    : createTtyApprovalResolver({
        nonInteractive: options.autoApprove === true ? 'approve' : 'reject',
      });

  // Phase 6: --queue-approvals routes approval_required tool calls through
  // the persistent approval queue instead of asking the inline resolver.
  // We open a dedicated DB handle so the queue path works even when audit
  // is disabled. Closed in the `finally` block below.
  const queueApprovals = options.queueApprovals === true;
  let queueDb: AgentOsDb | null = null;
  let queueDbCloseOnFinally = false;
  let approvalsQueued = 0;
  let queueDefaultTtlSeconds: number | null = null;
  if (queueApprovals) {
    try {
      queueDb = await openOrInitWorkspaceDb(workspaceRoot);
      queueDbCloseOnFinally = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`agent-os run: --queue-approvals setup failed: ${message}\n`);
      return 1;
    }
    queueDefaultTtlSeconds = (config.approvals.default_ttl_minutes ?? 60) * 60;
  }

  let exitCode = 1;
  let sawDone = false;
  let finalReason: 'completed' | 'cancelled' | 'error' = 'error';
  try {
    const wrapped = interceptProviderStream(provider, input, {
      agent: def.frontmatter,
      security: config.security,
      approvalResolver,
      ...(auditor ? { auditor } : {}),
      ...(queueApprovals && queueDb
        ? {
            mode: 'queue' as const,
            queue: {
              db: queueDb,
              requestedBy: `agent:${def.frontmatter.id}`,
              defaultTtlSeconds: queueDefaultTtlSeconds,
            },
          }
        : {}),
    });

    // Backpressure: a `for await` loop pulls one event at a time. We do not
    // buffer the whole stream into memory.
    for await (const event of wrapped) {
      writeEvent(event, { json, color });
      if (queueApprovals && event.type === 'approval_requested') {
        approvalsQueued += 1;
      }
      if (event.type === 'done') {
        sawDone = true;
        finalReason = event.reason;
        exitCode = exitCodeFor(event.reason);
      }
    }
    if (!sawDone) {
      // Provider returned without emitting `done` — treat as an error.
      process.stderr.write('agent-os run: provider ended without a done event\n');
      finalReason = 'error';
      exitCode = 1;
    }
    if (queueApprovals && approvalsQueued > 0) {
      // Surface the pause to stderr regardless of exit code — the queued
      // approvals are the user's signal that the run is parked.
      process.stderr.write(
        `agent-os run: paused — ${approvalsQueued} approval${
          approvalsQueued === 1 ? '' : 's'
        } queued. See \`agent-os approvals list\`.\n`,
      );
      if (exitCode === 0) {
        exitCode = 1;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`agent-os run: ${message}\n`);
    finalReason = 'error';
    exitCode = 1;
  } finally {
    process.off('SIGINT', onSigint);
    if (auditor && auditorIsFinalizable) {
      try {
        await (auditor as SqliteAuditor).finalize(finalReason);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`agent-os run: audit finalize failed: ${message}\n`);
      }
    }
    if (queueDbCloseOnFinally && queueDb) {
      try {
        queueDb.$sqlite.close();
      } catch {
        // Ignore close errors — best-effort cleanup.
      }
    }
  }

  return exitCode;
}

/** Type-guard for the SQLite-backed auditor's `finalize` capability. */
function isSqliteAuditor(a: ToolAuditor | SqliteAuditor): a is SqliteAuditor {
  return typeof (a as Partial<SqliteAuditor>).finalize === 'function';
}

/**
 * Default auditor factory. Opens (or creates) `<workspaceRoot>/.agent-os/db.sqlite`,
 * runs migrations idempotently, and returns a SQLite-backed auditor.
 *
 * Note: the database file lives at `db.sqlite` (not `agent-os.sqlite`) per the
 * Phase 4 spec for this bundle — the `agent` command's path is a separate
 * concern that Phase 5+ will reconcile.
 */
async function defaultAuditorFactory(args: {
  workspaceRoot: string;
  agentId: string;
  provider: string;
  model: string;
  redactSecrets?: boolean;
}): Promise<SqliteAuditor> {
  const dbDir = join(args.workspaceRoot, '.agent-os');
  const dbPath = join(dbDir, 'db.sqlite');
  const blobsRoot = join(dbDir, 'blobs');
  const db = openDatabase(dbPath);
  try {
    await runMigrations(db, { log: () => undefined });
  } catch (err) {
    db.$sqlite.close();
    throw err;
  }
  const blobs = createBlobStore({ root: blobsRoot });
  return createSqliteAuditor({
    db,
    blobs,
    agentId: args.agentId,
    provider: args.provider,
    model: args.model,
    ...(args.redactSecrets !== undefined ? { redactSecrets: args.redactSecrets } : {}),
  });
}

/**
 * Open (or create) the workspace's `.agent-os/db.sqlite` and apply
 * migrations. Returns a Drizzle handle that the caller is responsible for
 * closing. Used by `--queue-approvals` to persist queue rows.
 */
async function openOrInitWorkspaceDb(workspaceRoot: string): Promise<AgentOsDb> {
  const dbDir = join(workspaceRoot, '.agent-os');
  const dbPath = join(dbDir, 'db.sqlite');
  const db = openDatabase(dbPath);
  try {
    await runMigrations(db, { log: () => undefined });
  } catch (err) {
    db.$sqlite.close();
    throw err;
  }
  return db;
}

/** Write a single `RunEvent` to stdout in the selected format. */
function writeEvent(event: RunEvent, opts: { json: boolean; color: boolean }): void {
  const line = opts.json ? renderJsonLine(event) : renderEvent(event, { color: opts.color });
  process.stdout.write(line + '\n');
}

export function buildRunCommand(): Command {
  const cmd = new Command('run');
  cmd
    .description('Run an agent end-to-end and stream its transcript to stdout')
    .argument('<agent-id>', 'Id of the agent to run (see `agent-os agent list`)')
    .argument('<goal...>', 'Goal text (variadic — quotes optional)')
    .option('--json', 'Emit one RunEvent per line as JSONL', false)
    .option('--model <name>', "Override the agent's default model")
    .option('--no-mcp', 'Skip loading MCP servers (passes mcpServers: {})')
    .option('--cwd <dir>', "Pass through as the run's working directory")
    .option('--provider <id>', "Override the agent's declared provider")
    .option('--no-color', 'Disable ANSI colour output')
    .option('--no-audit', 'Skip writing tool_calls to the SQLite audit log')
    .option('--auto-approve', 'Auto-approve approval_required tools (explicit override)', false)
    .option(
      '--queue-approvals',
      'Persist approval_required tool calls to the queue instead of asking inline (pauses the run)',
      false,
    )
    .action(async (agentId: string, goal: string[], options: RunCliOptions) => {
      let code: number;
      try {
        code = await runAgent(process.cwd(), agentId, goal, options);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`agent-os run: ${message}\n`);
        code = 1;
      }
      if (code !== 0) {
        process.exit(code);
      }
    });
  return cmd;
}
