/**
 * `claude_code_local` provider — drives the Claude Agent SDK against the
 * user's existing Claude Code Max login (PRD §2.2, Phase 3).
 *
 * Critical invariants:
 *
 * - Does NOT read `ANTHROPIC_API_KEY` / `CLAUDE_API_KEY` / `OPENAI_API_KEY`
 *   from `process.env`. Authentication is delegated entirely to the SDK,
 *   which inherits the Max-plan OAuth session.
 * - Honestly emits `cost: null` and `tokens: null` on `done`. The SDK does
 *   surface `total_cost_usd` and a `usage` block in its final result message,
 *   but on a Max-plan login those values are not reliable accounting — they
 *   reflect what the API would have charged, not what the user is billed.
 *   Phase 11 will revisit for `anthropic_api` / `openai_api`.
 * - Passes MCP server config from `.mcp.json` (or `input.mcpServers`) through
 *   to the SDK's `mcpServers` option verbatim. Do not silently strip fields.
 *
 * The SDK entrypoint is `query(params)` returning a `Query` (an
 * `AsyncGenerator<SDKMessage>`). See `@anthropic-ai/claude-agent-sdk`'s
 * README; the live shape is the source of truth — `mapSdkEvent` is structural
 * so a minor SDK version bump that adds new message subtypes is tolerated.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { loadConfig } from '../../config/index.js';
import { AgentOsConfigSchema } from '../../config/schema.js';
import { defaultCapabilitiesFor } from '../../core/providers/index.js';
import type {
  AgentRunInput,
  Capabilities,
  McpServerConfig,
  Provider,
  RunEvent,
} from '../../core/providers/index.js';

import { loadMcpServers } from './mcp.js';

// The SDK module is imported dynamically so the adapter file can be loaded in
// environments where the SDK isn't installed (tests use an injected mock).
type SdkModule = {
  query: (params: {
    prompt: string;
    options?: {
      cwd?: string;
      systemPrompt?: string | { type: 'preset'; preset: 'claude_code'; append?: string };
      appendSystemPrompt?: string;
      mcpServers?: Record<string, McpServerConfig>;
      allowedTools?: string[];
      model?: string;
      abortController?: AbortController;
      env?: Record<string, string | undefined>;
    };
  }) => AsyncIterable<unknown> & { interrupt?: () => Promise<void> };
};

export interface ClaudeCodeLocalProviderOptions {
  /** Hook for tests to inject a stub SDK. Default: real dynamic import. */
  sdkImport?: () => Promise<SdkModule>;
}

/** Adapter that runs an Agent OS agent through the Claude Agent SDK. */
export class ClaudeCodeLocalProvider implements Provider {
  readonly id = 'claude_code_local' as const;
  readonly capabilities: Capabilities = defaultCapabilitiesFor('claude_code_local');

  private readonly sdkImport: () => Promise<SdkModule>;

  constructor(opts: ClaudeCodeLocalProviderOptions = {}) {
    this.sdkImport =
      opts.sdkImport ??
      ((): Promise<SdkModule> =>
        import('@anthropic-ai/claude-agent-sdk') as unknown as Promise<SdkModule>);
  }

  run(input: AgentRunInput): AsyncIterable<RunEvent> {
    const sdkImport = this.sdkImport;
    return runImpl(input, sdkImport);
  }
}

async function* runImpl(
  input: AgentRunInput,
  sdkImport: () => Promise<SdkModule>,
): AsyncGenerator<RunEvent, void, void> {
  const start = Date.now();
  const signal = input.signal;

  // Resolve MCP servers — caller wins, otherwise fall back to .mcp.json.
  // Phase 4: honour `security.pinned_mcp_servers` from the workspace config so
  // unsigned servers are dropped before they reach the SDK. When the config is
  // absent (e.g. tests, ad-hoc workspaces) we default to permissive — pinning
  // is opt-in, declared in config.
  const pinned = loadPinnedFlag(input.workspaceRoot);
  const mcpServers =
    input.mcpServers ?? (await safeLoadMcpServers(input.workspaceRoot, { pinned }));

  // Compose the prompt: user goal goes through `prompt`, the agent's body
  // becomes the system prompt via `appendSystemPrompt` so the SDK's own
  // Claude Code preset still applies (PRD §2.2 — adapters compose, don't
  // replace, the harness).
  const prompt = input.goal;
  const appendSystemPrompt = input.instructions;

  // Bridge AbortSignal → SDK's AbortController.
  const abortController = new AbortController();
  const onAbort = (): void => abortController.abort();
  if (signal !== undefined) {
    if (signal.aborted) abortController.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  // Buffer state for assistant text deltas — flushed on tool_call or stream end.
  const buffer = newAssistantBuffer();

  // Whether we've already yielded a `done` event (for early-abort paths).
  let doneEmitted = false;
  const emitDone = (reason: 'completed' | 'cancelled' | 'error'): RunEvent => ({
    type: 'done',
    reason,
    cost: null,
    tokens: null,
    durationMs: Date.now() - start,
    timestamp: Date.now(),
  });

  let sdk: SdkModule;
  try {
    sdk = await sdkImport();
  } catch (err) {
    yield {
      type: 'error',
      message: `claude_code_local: failed to load SDK (${describe(err)})`,
      recoverable: false,
      timestamp: Date.now(),
    };
    yield emitDone('error');
    cleanup();
    return;
  }

  let stream: AsyncIterable<unknown> & { interrupt?: () => Promise<void> };
  try {
    stream = sdk.query({
      prompt,
      options: {
        cwd: input.cwd ?? input.workspaceRoot,
        appendSystemPrompt,
        mcpServers,
        allowedTools: input.allowedTools,
        model: input.model,
        abortController,
      },
    });
  } catch (err) {
    yield {
      type: 'error',
      message: `claude_code_local: SDK query() threw (${describe(err)})`,
      recoverable: false,
      timestamp: Date.now(),
    };
    yield emitDone('error');
    cleanup();
    return;
  }

  try {
    for await (const sdkEvent of stream) {
      if (signal?.aborted) {
        await tryInterrupt(stream);
        yield emitDone('cancelled');
        doneEmitted = true;
        return;
      }

      const mapped = mapSdkEvent(sdkEvent, buffer);
      if (mapped === null) continue;
      const events = Array.isArray(mapped) ? mapped : [mapped];
      for (const event of events) yield event;
    }

    // Stream ended normally — flush any pending assistant text.
    const tail = flushAssistantBuffer(buffer);
    if (tail !== null) yield tail;

    if (signal?.aborted) {
      yield emitDone('cancelled');
    } else {
      yield emitDone('completed');
    }
    doneEmitted = true;
  } catch (err) {
    if (!doneEmitted) {
      yield {
        type: 'error',
        message: `claude_code_local: stream failed (${describe(err)})`,
        recoverable: false,
        timestamp: Date.now(),
      };
      yield emitDone(signal?.aborted === true ? 'cancelled' : 'error');
      doneEmitted = true;
    }
  } finally {
    cleanup();
  }

  function cleanup(): void {
    if (signal !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

async function tryInterrupt(
  stream: AsyncIterable<unknown> & { interrupt?: () => Promise<void> },
): Promise<void> {
  if (typeof stream.interrupt === 'function') {
    try {
      await stream.interrupt();
    } catch {
      // Cancellation is best-effort — the AbortController already signalled.
    }
  }
}

async function safeLoadMcpServers(
  workspaceRoot: string,
  opts: { pinned: boolean },
): Promise<Record<string, McpServerConfig>> {
  try {
    return await loadMcpServers(workspaceRoot, opts);
  } catch {
    return {};
  }
}

/**
 * Read `security.pinned_mcp_servers` from the workspace's config.
 *
 * Missing config file → fall back to the schema default (`true`) so that an
 * operator who deletes `agent-os.config.yaml` cannot silently downgrade pinning
 * on both enforcement paths at once. Parse failures still fall back to `false`
 * — failing closed there would brick adapter tests against malformed configs
 * and produce a worse error than the SDK loader's own validation. The hook-side
 * enforcement remains the second line of defense for any config-loading bypass.
 */
function loadPinnedFlag(workspaceRoot: string): boolean {
  const configPath = resolve(workspaceRoot, 'agent-os.config.yaml');
  if (!existsSync(configPath)) {
    return AgentOsConfigSchema.parse({}).security.pinned_mcp_servers;
  }
  try {
    return loadConfig(configPath).security.pinned_mcp_servers;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Event mapping
// ---------------------------------------------------------------------------

/**
 * Mutable buffer carried across `mapSdkEvent` calls so assistant text deltas
 * can be coalesced into one `message` per turn. The buffer is flushed when a
 * non-text event (tool_call, error) is observed, or at end-of-stream.
 */
export interface AssistantBuffer {
  text: string;
  /** ISO-ish stable timestamp captured when the buffer first received text. */
  startedAt: number | null;
}

/** Construct an empty assistant-text buffer. */
export function newAssistantBuffer(): AssistantBuffer {
  return { text: '', startedAt: null };
}

/** Emit a `message` event from the buffer if non-empty and reset it. */
export function flushAssistantBuffer(buffer: AssistantBuffer): RunEvent | null {
  if (buffer.text.length === 0) return null;
  const event: RunEvent = {
    type: 'message',
    role: 'assistant',
    text: buffer.text,
    timestamp: buffer.startedAt ?? Date.now(),
  };
  buffer.text = '';
  buffer.startedAt = null;
  return event;
}

/**
 * Translate a Claude Agent SDK message into zero, one, or several `RunEvent`s.
 *
 * Exported so it can be unit-tested against fixture shapes without spinning
 * up the SDK. Structure-typed (not nominal) on purpose — minor SDK additions
 * fall through the `default` branch as `null` rather than crashing.
 */
export function mapSdkEvent(raw: unknown, buffer: AssistantBuffer): RunEvent | RunEvent[] | null {
  if (raw === null || typeof raw !== 'object') return null;
  const ev = raw as Record<string, unknown>;
  const type = ev.type;
  const ts = Date.now();

  switch (type) {
    case 'assistant': {
      // SDKAssistantMessage shape: { type: 'assistant', message: BetaMessage, ... }
      // BetaMessage.content is an array of content blocks; text blocks have
      // { type: 'text', text }, tool_use blocks { type: 'tool_use', id, name, input }.
      const events: RunEvent[] = [];
      const message = ev.message;
      const content =
        message !== null && typeof message === 'object'
          ? (message as { content?: unknown }).content
          : undefined;

      if (Array.isArray(content)) {
        for (const block of content) {
          if (block === null || typeof block !== 'object') continue;
          const b = block as Record<string, unknown>;
          if (b.type === 'text' && typeof b.text === 'string') {
            if (buffer.startedAt === null) buffer.startedAt = ts;
            buffer.text += b.text;
          } else if (b.type === 'tool_use') {
            // Flush any pending assistant text before the tool call.
            const flushed = flushAssistantBuffer(buffer);
            if (flushed !== null) events.push(flushed);
            const id =
              typeof b.id === 'string' ? b.id : `tc_${Math.random().toString(36).slice(2)}`;
            const tool = typeof b.name === 'string' ? b.name : 'unknown';
            events.push({
              type: 'tool_call',
              toolCallId: id,
              tool,
              args: b.input,
              timestamp: ts,
            });
          }
        }
      }

      // If the SDK signalled an authentication / billing error on this message,
      // surface it as an error event so the caller doesn't silently lose work.
      const errCode = ev.error;
      if (typeof errCode === 'string') {
        const flushed = flushAssistantBuffer(buffer);
        if (flushed !== null) events.push(flushed);
        events.push({
          type: 'error',
          message: `claude_code_local: assistant error (${errCode})`,
          recoverable: errCode === 'rate_limit',
          timestamp: ts,
        });
      }

      return events.length === 0 ? null : events;
    }

    case 'user': {
      // tool_result blocks live inside SDKUserMessage.message.content.
      const message = ev.message;
      const content =
        message !== null && typeof message === 'object'
          ? (message as { content?: unknown }).content
          : undefined;
      if (!Array.isArray(content)) return null;
      const events: RunEvent[] = [];
      for (const block of content) {
        if (block === null || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        if (b.type !== 'tool_result') continue;
        const id = typeof b.tool_use_id === 'string' ? b.tool_use_id : '';
        events.push({
          type: 'tool_result',
          toolCallId: id,
          result: b.content,
          timestamp: ts,
          ...(b.is_error === true ? { isError: true } : {}),
        });
      }
      return events.length === 0 ? null : events;
    }

    case 'system': {
      // SDKPermissionDeniedMessage: { type: 'system', subtype: 'permission_denied', ... }
      if (ev.subtype !== 'permission_denied') return null;
      const flushed = flushAssistantBuffer(buffer);
      const events: RunEvent[] = [];
      if (flushed !== null) events.push(flushed);
      const toolCallId = typeof ev.tool_use_id === 'string' ? ev.tool_use_id : '';
      const tool = typeof ev.tool_name === 'string' ? ev.tool_name : 'unknown';
      const reason = typeof ev.decision_reason === 'string' ? ev.decision_reason : undefined;
      events.push({
        type: 'approval_requested',
        toolCallId,
        tool,
        args: undefined,
        ...(reason !== undefined ? { reason } : {}),
        timestamp: ts,
      });
      return events;
    }

    case 'result': {
      // The SDK's final result is end-of-stream — the adapter's outer loop
      // emits the canonical `done`. If the result is an error, surface it
      // first.
      if (ev.subtype !== 'success') {
        const errors = ev.errors;
        const message =
          Array.isArray(errors) && errors.length > 0
            ? String(errors[0])
            : `result ${String(ev.subtype)}`;
        const flushed = flushAssistantBuffer(buffer);
        const out: RunEvent[] = [];
        if (flushed !== null) out.push(flushed);
        out.push({
          type: 'error',
          message: `claude_code_local: ${message}`,
          recoverable: false,
          timestamp: ts,
        });
        return out;
      }
      return null;
    }

    default:
      return null;
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
