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
import { renderEvent, renderJsonLine } from '../transcript.js';

/** CLI flag bag for `agent-os run`. */
interface RunCliOptions {
  json?: boolean;
  model?: string;
  mcp?: boolean; // Commander turns `--no-mcp` into `mcp: false`.
  cwd?: string;
  provider?: string;
  color?: boolean; // Commander turns `--no-color` into `color: false`.
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

  let exitCode = 1;
  let sawDone = false;
  try {
    // Backpressure: a `for await` loop pulls one event at a time. We do not
    // buffer the whole stream into memory.
    for await (const event of provider.run(input)) {
      writeEvent(event, { json, color });
      if (event.type === 'done') {
        sawDone = true;
        exitCode = exitCodeFor(event.reason);
      }
    }
    if (!sawDone) {
      // Provider returned without emitting `done` — treat as an error.
      process.stderr.write('agent-os run: provider ended without a done event\n');
      exitCode = 1;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`agent-os run: ${message}\n`);
    exitCode = 1;
  } finally {
    process.off('SIGINT', onSigint);
  }

  return exitCode;
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
