/**
 * `openai_api` provider — drives the OpenAI Chat Completions API for users who
 * bring their own `OPENAI_API_KEY` (PRD §2.2, Phase 11).
 *
 * Invariants:
 *
 * - Requires `process.env.OPENAI_API_KEY` at `run()` time; missing key surfaces
 *   as an `error` + `done(reason:'error')` rather than a thrown exception.
 * - Honours `defaultCapabilitiesFor('openai_api')`: `mcp:false`,
 *   `promptCaching:false`. Anthropic-only flags stay off — PRD Phase 11 says
 *   "mark Anthropic-only capability flags unavailable".
 * - Single-shot: yields the first tool_call(s) and ends the turn. Multi-turn
 *   tool execution (resolve → re-prompt) is upstream's job, just like the
 *   `claude_code_local` and `anthropic_api` adapters.
 * - Tool names: OpenAI's function-name regex is `^[A-Za-z0-9_-]+$`, so the
 *   adapter rewrites `.` → `_` when wiring tools out, and restores the
 *   original id on the `tool_call` event emitted back to upstream.
 * - MCP: `input.mcpServers` is ignored. Tool ids beginning with `mcp.<server>.`
 *   are also dropped before the tools array is built (capability is `mcp:false`).
 */

import { createRequire } from 'node:module';

import { defaultCapabilitiesFor } from '../../core/providers/index.js';
import type {
  AgentRunInput,
  Capabilities,
  Provider,
  RunEvent,
} from '../../core/providers/index.js';

// ---------------------------------------------------------------------------
// Minimal structural types for the slice of OpenAI's surface we touch.
// We deliberately do not re-export the SDK's full types so test fakes can be
// authored without importing `openai`.
// ---------------------------------------------------------------------------

export interface OpenAiToolFunctionParam {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      additionalProperties: boolean;
    };
  };
}

export interface OpenAiChatMessageParam {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface OpenAiCreateParams {
  model: string;
  messages: OpenAiChatMessageParam[];
  tools?: OpenAiToolFunctionParam[];
  stream: true;
  stream_options?: { include_usage?: boolean };
}

export interface OpenAiToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface OpenAiChunkChoice {
  index: number;
  delta?: {
    role?: string;
    content?: string | null;
    tool_calls?: OpenAiToolCallDelta[];
  };
  finish_reason?: string | null;
}

export interface OpenAiUsage {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
}

export interface OpenAiChunk {
  choices?: OpenAiChunkChoice[];
  usage?: OpenAiUsage | null;
}

export type OpenAiStream = AsyncIterable<OpenAiChunk>;

export interface OpenAiLike {
  chat: {
    completions: {
      create: (params: OpenAiCreateParams) => Promise<OpenAiStream> | OpenAiStream;
    };
  };
}

export interface OpenAiApiProviderOptions {
  /** Test hook: inject a mock OpenAI client. */
  clientFactory?: (env: NodeJS.ProcessEnv) => OpenAiLike;
  /** Default model. Default: 'gpt-4.1'. */
  defaultModel?: string;
}

// ---------------------------------------------------------------------------
// Cost helper
// ---------------------------------------------------------------------------

/**
 * Per-million-token rates (USD) for known OpenAI models. Conservative,
 * documented public list rates; an unknown model falls back to `null` so the
 * caller can't be misled into thinking they have honest cost data.
 */
const PRICING_PER_MTOK: Record<string, { input: number; output: number }> = {
  'gpt-4.1': { input: 2.0, output: 8.0 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-5': { input: 5.0, output: 15.0 },
};

/** Compute USD cost for a usage block and model. Returns `null` if unknown. */
export function computeCost(usage: OpenAiUsage | null | undefined, model: string): number | null {
  if (usage === null || usage === undefined) return null;
  const rates = PRICING_PER_MTOK[model];
  if (rates === undefined) return null;
  const input = usage.prompt_tokens ?? 0;
  const output = usage.completion_tokens ?? 0;
  return (input * rates.input + output * rates.output) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Tool mapping
// ---------------------------------------------------------------------------

/** Function-name shape the OpenAI tools API accepts. */
const OPENAI_NAME_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Build the OpenAI `tools` array from Agent OS tool ids. Returns the tools
 * plus a `nameToOriginalId` map used to restore the original id on the
 * outbound `tool_call` event.
 *
 * Tool ids beginning with `mcp.` are skipped: capability says `mcp:false`, so
 * the adapter cannot honour MCP tool calls even if the model emits one.
 */
export function mapTools(
  allowed: string[] | undefined,
  approvalRequired: string[] | undefined,
): { tools: OpenAiToolFunctionParam[]; nameToOriginalId: Map<string, string> } {
  const dedup = new Map<string, string>(); // originalId → originalId
  for (const id of allowed ?? []) dedup.set(id, id);
  for (const id of approvalRequired ?? []) dedup.set(id, id);

  const tools: OpenAiToolFunctionParam[] = [];
  const nameToOriginalId = new Map<string, string>();

  for (const originalId of dedup.keys()) {
    // Skip MCP tools — capability is `mcp:false`.
    if (originalId.startsWith('mcp.')) continue;
    const name = originalId.includes('.') ? originalId.replaceAll('.', '_') : originalId;
    // Defensive: if a tool id contains other illegal chars we drop it. Better
    // to omit one tool than to ship a request the API will reject outright.
    if (!OPENAI_NAME_RE.test(name)) continue;
    nameToOriginalId.set(name, originalId);
    tools.push({
      type: 'function',
      function: {
        name,
        description: `Agent OS tool: ${originalId}`,
        parameters: {
          type: 'object',
          properties: {},
          additionalProperties: true,
        },
      },
    });
  }

  return { tools, nameToOriginalId };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/** Adapter that runs an Agent OS agent through the OpenAI Chat Completions API. */
export class OpenAiApiProvider implements Provider {
  readonly id = 'openai_api' as const;
  readonly capabilities: Capabilities = defaultCapabilitiesFor('openai_api');

  private readonly clientFactory: (env: NodeJS.ProcessEnv) => OpenAiLike;
  private readonly defaultModel: string;
  private cachedClient: OpenAiLike | null = null;

  constructor(opts: OpenAiApiProviderOptions = {}) {
    this.clientFactory =
      opts.clientFactory ??
      ((env: NodeJS.ProcessEnv): OpenAiLike => {
        // Lazy require via `createRequire` keeps this module loadable in
        // environments where the SDK isn't installed and tests inject a fake.
        const localRequire = createRequire(import.meta.url);
        const mod = localRequire('openai') as {
          default: new (cfg?: { apiKey?: string }) => OpenAiLike;
        };
        return new mod.default({ apiKey: env.OPENAI_API_KEY });
      });
    this.defaultModel = opts.defaultModel ?? 'gpt-4.1';
  }

  run(input: AgentRunInput): AsyncIterable<RunEvent> {
    return runImpl(input, () => this.getOrBuildClient(), this.defaultModel);
  }

  private getOrBuildClient(): OpenAiLike {
    if (this.cachedClient === null) {
      this.cachedClient = this.clientFactory(process.env);
    }
    return this.cachedClient;
  }
}

async function* runImpl(
  input: AgentRunInput,
  buildClient: () => OpenAiLike,
  defaultModel: string,
): AsyncGenerator<RunEvent, void, void> {
  const start = Date.now();
  const signal = input.signal;
  const model = input.model ?? defaultModel;

  const emitDone = (
    reason: 'completed' | 'cancelled' | 'error',
    cost: number | null,
    tokens: { input: number | null; output: number | null } | null,
  ): RunEvent => ({
    type: 'done',
    reason,
    cost,
    tokens,
    durationMs: Date.now() - start,
    timestamp: Date.now(),
  });

  // Auth check happens at run() time, not construction, so a process that
  // never calls a key-requiring provider doesn't have to set one.
  if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY.trim() === '') {
    yield {
      type: 'error',
      message: 'OPENAI_API_KEY not set',
      recoverable: false,
      timestamp: Date.now(),
    };
    yield emitDone('error', null, null);
    return;
  }

  if (isAborted(signal)) {
    yield emitDone('cancelled', null, null);
    return;
  }

  let client: OpenAiLike;
  try {
    client = buildClient();
  } catch (err) {
    yield {
      type: 'error',
      message: `openai_api: failed to construct client (${describe(err)})`,
      recoverable: false,
      timestamp: Date.now(),
    };
    yield emitDone('error', null, null);
    return;
  }

  const { tools, nameToOriginalId } = mapTools(input.allowedTools, input.approvalRequiredTools);

  const messages: OpenAiChatMessageParam[] = [
    { role: 'system', content: input.instructions },
    { role: 'user', content: input.goal },
  ];

  const params: OpenAiCreateParams = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(tools.length > 0 ? { tools } : {}),
  };

  let stream: OpenAiStream;
  try {
    const created = client.chat.completions.create(params);
    stream = await Promise.resolve(created);
  } catch (err) {
    yield {
      type: 'error',
      message: `openai_api: request failed (${describe(err)})`,
      recoverable: false,
      timestamp: Date.now(),
    };
    yield emitDone('error', null, null);
    return;
  }

  // Per-index buffer for streamed tool_calls. OpenAI sends partial JSON in
  // `function.arguments` chunked across multiple deltas keyed by `index`.
  interface ToolBuf {
    id: string | null;
    name: string | null;
    args: string;
  }
  const toolBufs = new Map<number, ToolBuf>();

  let textBuf = '';
  let textStartedAt: number | null = null;
  let usage: OpenAiUsage | null = null;
  let finishedWithToolCalls = false;

  try {
    for await (const chunk of stream) {
      if (isAborted(signal)) {
        yield emitDone(
          'cancelled',
          usage !== null ? computeCost(usage, model) : null,
          usage !== null ? normaliseUsage(usage) : null,
        );
        return;
      }

      if (chunk.usage !== null && chunk.usage !== undefined) {
        usage = chunk.usage;
      }

      const choice = chunk.choices?.[0];
      if (choice === undefined) continue;
      const delta = choice.delta;

      if (delta?.content !== null && delta?.content !== undefined && delta.content.length > 0) {
        if (textStartedAt === null) textStartedAt = Date.now();
        textBuf += delta.content;
      }

      if (Array.isArray(delta?.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const buf = toolBufs.get(tc.index) ?? { id: null, name: null, args: '' };
          if (typeof tc.id === 'string' && tc.id.length > 0) buf.id = tc.id;
          if (typeof tc.function?.name === 'string' && tc.function.name.length > 0) {
            buf.name = tc.function.name;
          }
          if (typeof tc.function?.arguments === 'string') {
            buf.args += tc.function.arguments;
          }
          toolBufs.set(tc.index, buf);
        }
      }

      if (choice.finish_reason === 'tool_calls') {
        finishedWithToolCalls = true;
      }
    }
  } catch (err) {
    if (isAborted(signal)) {
      yield emitDone('cancelled', null, null);
      return;
    }
    yield {
      type: 'error',
      message: `openai_api: stream failed (${describe(err)})`,
      recoverable: false,
      timestamp: Date.now(),
    };
    yield emitDone('error', null, null);
    return;
  }

  // Flush accumulated assistant text if any.
  if (textBuf.length > 0) {
    yield {
      type: 'message',
      role: 'assistant',
      text: textBuf,
      timestamp: textStartedAt ?? Date.now(),
    };
  }

  // Emit each buffered tool call (sorted by index for determinism).
  const sortedIndexes = [...toolBufs.keys()].sort((a, b) => a - b);
  for (const idx of sortedIndexes) {
    const buf = toolBufs.get(idx);
    if (buf === undefined || buf.name === null) continue;
    const toolCallId = buf.id ?? `tc_${idx}_${Math.random().toString(36).slice(2)}`;
    let parsed: unknown;
    try {
      parsed = buf.args.length === 0 ? {} : JSON.parse(buf.args);
    } catch {
      // Surface as error but continue emitting the tool_call with the raw
      // string so the caller can at least see what the model attempted.
      parsed = { _raw: buf.args };
    }
    const originalId = nameToOriginalId.get(buf.name) ?? buf.name;
    yield {
      type: 'tool_call',
      toolCallId,
      tool: originalId,
      args: parsed,
      timestamp: Date.now(),
    };
  }

  if (isAborted(signal)) {
    yield emitDone('cancelled', computeCost(usage, model), normaliseUsage(usage));
    return;
  }

  // `finishedWithToolCalls` is informational — single-shot semantics mean the
  // adapter ends the turn either way. Upstream re-prompts with tool_result(s).
  void finishedWithToolCalls;

  yield emitDone('completed', computeCost(usage, model), normaliseUsage(usage));
}

function normaliseUsage(
  usage: OpenAiUsage | null,
): { input: number | null; output: number | null } | null {
  if (usage === null) return null;
  return {
    input: usage.prompt_tokens ?? null,
    output: usage.completion_tokens ?? null,
  };
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Narrowing-safe check for `signal.aborted`. Inline `signal?.aborted === true`
 * triggers TS narrowing surprises across multiple checks in the same function
 * (TS treats `AbortSignal.aborted` as `boolean` but narrows it to the same
 * literal across re-reads).
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}
