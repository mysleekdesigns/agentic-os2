/**
 * `anthropic_api` provider — drives the Anthropic Messages API directly
 * against an `ANTHROPIC_API_KEY` (PRD §2.2, Phase 11).
 *
 * Critical invariants:
 *
 * - The SDK client is built lazily inside `run()`. Importing this module
 *   does not read env vars or instantiate any client, which keeps
 *   FakeProvider / no-key code paths fully unaffected.
 * - If `ANTHROPIC_API_KEY` is empty/unset when `run()` is invoked, the
 *   adapter yields a typed `error` + `done(reason:'error')` pair instead
 *   of throwing. PRD §4 quality bar — no-API-key path must degrade
 *   gracefully.
 * - Prompt caching is on by default: the system prompt is sent with
 *   `cache_control: { type: 'ephemeral' }`. PRD Phase 11 outcome.
 * - The Messages API has no MCP passthrough — tool ids of the form
 *   `mcp.<server>.<tool>` or `mcp__<server>__<tool>` are dropped before
 *   the request is built, matching `defaultCapabilitiesFor` which
 *   advertises `mcp: false`.
 * - Token usage is forwarded honestly from `final.usage.{input_tokens,
 *   output_tokens}`. Cost is computed from a small static lookup; unknown
 *   models return `null` rather than a fabricated number.
 *
 * Phase 11: single-shot — tool execution & follow-up turns are handled by
 * the interceptor/runner layer (`src/core/tools/interceptor.ts`) upstream
 * of providers. The adapter emits the `tool_call` events for the first
 * assistant turn and then ends the stream; multi-turn tool use is a
 * future enhancement.
 */

import { BUILTIN_TOOL_RISKS } from '../../core/tools/risk.js';
import { defaultCapabilitiesFor } from '../../core/providers/index.js';
import type {
  AgentRunInput,
  Capabilities,
  Provider,
  RunEvent,
} from '../../core/providers/index.js';

import type {
  AnthropicFinalMessage,
  AnthropicLike,
  AnthropicMessageStream,
  AnthropicStreamEvent,
  AnthropicStreamParams,
  AnthropicUsage,
} from './types.js';

/** Per-MTok rates (USD) — input/output for known models. PRD §2.2 honesty. */
const COST_TABLE: Readonly<Record<string, { input: number; output: number }>> = Object.freeze({
  'claude-opus-4-7': { input: 15, output: 75 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 0.8, output: 4 },
});

/** Default model when `AgentRunInput.model` is not provided. */
const DEFAULT_MODEL = 'claude-sonnet-4-6';

export interface AnthropicApiProviderOptions {
  /** Test hook: inject a mock Anthropic client. Default constructs a real one. */
  clientFactory?: (env: NodeJS.ProcessEnv) => AnthropicLike;
  /** Default model used when AgentRunInput.model is not set. Default: 'claude-sonnet-4-6'. */
  defaultModel?: string;
}

/** Adapter that runs an Agent OS agent through the Anthropic Messages API. */
export class AnthropicApiProvider implements Provider {
  readonly id = 'anthropic_api' as const;
  readonly capabilities: Capabilities = defaultCapabilitiesFor('anthropic_api');

  private readonly clientFactory: (env: NodeJS.ProcessEnv) => AnthropicLike;
  private readonly defaultModel: string;

  constructor(opts: AnthropicApiProviderOptions = {}) {
    this.clientFactory = opts.clientFactory ?? defaultClientFactory;
    this.defaultModel = opts.defaultModel ?? DEFAULT_MODEL;
  }

  run(input: AgentRunInput): AsyncIterable<RunEvent> {
    return runImpl(input, this.clientFactory, this.defaultModel);
  }
}

/**
 * Default client factory — lazily loads the SDK via `createRequire` and
 * constructs a client. `createRequire` is used so this ESM module can pull in
 * the CJS-style default export without forcing the SDK to be present at
 * top-level import time (callers using `clientFactory` injection can still
 * use the adapter even if the SDK isn't installed).
 */
function defaultClientFactory(env: NodeJS.ProcessEnv): AnthropicLike {
  // Lazy require keeps the SDK out of the module graph until the adapter
  // actually runs. Tests inject a fake via `clientFactory`, so this branch is
  // never exercised in unit tests.
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const Anthropic = require('@anthropic-ai/sdk').default as new (cfg?: {
    apiKey?: string;
  }) => AnthropicLike;
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}

async function* runImpl(
  input: AgentRunInput,
  clientFactory: (env: NodeJS.ProcessEnv) => AnthropicLike,
  defaultModel: string,
): AsyncGenerator<RunEvent, void, void> {
  const start = Date.now();
  const signal = input.signal;

  const emitDone = (
    reason: 'completed' | 'cancelled' | 'error',
    extras?: {
      cost?: number | null;
      tokens?: { input: number | null; output: number | null } | null;
    },
  ): RunEvent => ({
    type: 'done',
    reason,
    cost: extras?.cost ?? null,
    tokens: extras?.tokens ?? null,
    durationMs: Date.now() - start,
    timestamp: Date.now(),
  });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey === '') {
    yield {
      type: 'error',
      message: 'ANTHROPIC_API_KEY not set',
      recoverable: false,
      timestamp: Date.now(),
    };
    yield emitDone('error');
    return;
  }

  let client: AnthropicLike;
  try {
    client = clientFactory(process.env);
  } catch (err) {
    yield {
      type: 'error',
      message: `anthropic_api: failed to construct client (${describe(err)})`,
      recoverable: false,
      timestamp: Date.now(),
    };
    yield emitDone('error');
    return;
  }

  const model = input.model ?? defaultModel;
  // The Messages API rejects tool names that don't match /^[A-Za-z0-9_-]{1,64}$/.
  // Agent OS canonical ids use dots (`fs.read`, `mcp.crawlforge.search_web`).
  // `buildTools` sanitises names; we keep the inverse map so the `tool_call`
  // event surfaces the original id upstream.
  const nameToOriginalId = new Map<string, string>();
  const tools = buildTools(input.allowedTools, input.approvalRequiredTools, nameToOriginalId);

  const params: AnthropicStreamParams = {
    model,
    max_tokens: 4096,
    system: [
      {
        type: 'text',
        text: input.instructions,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: input.goal }],
    ...(tools.length > 0 ? { tools } : {}),
  };

  let stream: AnthropicMessageStream;
  try {
    stream = client.messages.stream(params);
  } catch (err) {
    yield {
      type: 'error',
      message: `anthropic_api: stream() threw (${describe(err)})`,
      recoverable: false,
      timestamp: Date.now(),
    };
    yield emitDone('error');
    return;
  }

  // Per-block accumulators keyed by `index` from content_block_start.
  interface TextBlock {
    kind: 'text';
    text: string;
    startedAt: number;
  }
  interface ToolBlock {
    kind: 'tool_use';
    id: string;
    name: string;
    jsonBuf: string;
    startedAt: number;
  }
  const blocks = new Map<number, TextBlock | ToolBlock>();

  let cancelled = false;

  try {
    for await (const event of stream) {
      if (signal?.aborted) {
        cancelled = true;
        break;
      }

      const mapped = handleStreamEvent(event, blocks, nameToOriginalId);
      for (const out of mapped) yield out;
    }

    if (cancelled || signal?.aborted) {
      yield emitDone('cancelled');
      return;
    }

    // Drain any text blocks that never saw an explicit content_block_stop.
    // (Defensive — the SDK normally emits them, but a benign final flush keeps
    // assistant text from being lost on quirky streams.)
    for (const [, block] of blocks) {
      if (block.kind === 'text' && block.text.length > 0) {
        yield {
          type: 'message',
          role: 'assistant',
          text: block.text,
          timestamp: block.startedAt,
        };
      }
    }
    blocks.clear();

    let final: AnthropicFinalMessage;
    try {
      final = await stream.finalMessage();
    } catch (err) {
      if (signal?.aborted) {
        yield emitDone('cancelled');
        return;
      }
      yield {
        type: 'error',
        message: `anthropic_api: finalMessage() threw (${describe(err)})`,
        recoverable: false,
        timestamp: Date.now(),
      };
      yield emitDone('error');
      return;
    }

    const tokens = {
      input: typeof final.usage?.input_tokens === 'number' ? final.usage.input_tokens : null,
      output: typeof final.usage?.output_tokens === 'number' ? final.usage.output_tokens : null,
    };
    const cost = computeCost(final.usage, model);

    // For both `end_turn` and `tool_use` stop reasons we end the stream after
    // the events already emitted. See header comment — Phase 11 is single-shot.
    yield emitDone('completed', { cost, tokens });
  } catch (err) {
    if (signal?.aborted) {
      yield emitDone('cancelled');
      return;
    }
    yield {
      type: 'error',
      message: `anthropic_api: stream failed (${describe(err)})`,
      recoverable: false,
      timestamp: Date.now(),
    };
    yield emitDone('error');
  }
}

/** Apply a single stream event to the block map, returning any RunEvents to emit. */
function handleStreamEvent(
  event: AnthropicStreamEvent,
  blocks: Map<
    number,
    | { kind: 'text'; text: string; startedAt: number }
    | { kind: 'tool_use'; id: string; name: string; jsonBuf: string; startedAt: number }
  >,
  nameToOriginalId: Map<string, string>,
): RunEvent[] {
  const ts = Date.now();
  switch (event.type) {
    case 'content_block_start': {
      const cb = event.content_block;
      if (cb.type === 'text') {
        blocks.set(event.index, { kind: 'text', text: '', startedAt: ts });
      } else if (cb.type === 'tool_use') {
        blocks.set(event.index, {
          kind: 'tool_use',
          id: cb.id,
          name: cb.name,
          jsonBuf: '',
          startedAt: ts,
        });
      }
      return [];
    }
    case 'content_block_delta': {
      const block = blocks.get(event.index);
      if (block === undefined) return [];
      if (block.kind === 'text' && event.delta.type === 'text_delta') {
        block.text += event.delta.text;
      } else if (block.kind === 'tool_use' && event.delta.type === 'input_json_delta') {
        block.jsonBuf += event.delta.partial_json;
      }
      return [];
    }
    case 'content_block_stop': {
      const block = blocks.get(event.index);
      if (block === undefined) return [];
      blocks.delete(event.index);
      if (block.kind === 'text') {
        if (block.text.length === 0) return [];
        return [
          {
            type: 'message',
            role: 'assistant',
            text: block.text,
            timestamp: block.startedAt,
          },
        ];
      }
      // tool_use block — parse the accumulated JSON, fall back to {} on empty.
      const args = parseJsonOrEmpty(block.jsonBuf);
      const originalId = nameToOriginalId.get(block.name) ?? block.name;
      return [
        {
          type: 'tool_call',
          toolCallId: block.id,
          tool: originalId,
          args,
          timestamp: ts,
        },
      ];
    }
    case 'message_start':
    case 'message_delta':
    case 'message_stop':
      return [];
    default:
      return [];
  }
}

/**
 * Build the `tools` array for the Messages API from the agent's allowed +
 * approval-required tool lists. MCP-namespaced ids are dropped (the
 * Messages API does not proxy MCP). Builtin tool names get a permissive
 * stub schema; unknown ids likewise.
 */
function buildTools(
  allowed: readonly string[] | undefined,
  approvalRequired: readonly string[] | undefined,
  nameToOriginalId: Map<string, string>,
): NonNullable<AnthropicStreamParams['tools']> {
  const dedup = new Set<string>();
  for (const t of allowed ?? []) dedup.add(t);
  for (const t of approvalRequired ?? []) dedup.add(t);

  const tools: NonNullable<AnthropicStreamParams['tools']> = [];
  for (const id of dedup) {
    if (isMcpId(id)) continue;
    const safeName = sanitizeToolName(id);
    nameToOriginalId.set(safeName, id);
    tools.push({
      name: safeName,
      description: BUILTIN_TOOL_RISKS[id] !== undefined ? `Builtin tool: ${id}` : id,
      input_schema: {
        type: 'object',
        properties: {},
        additionalProperties: true,
      },
    });
  }
  return tools;
}

/** Coerce an Agent OS tool id into the Messages API's allowed name shape. */
function sanitizeToolName(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

function isMcpId(id: string): boolean {
  return id.startsWith('mcp.') || id.startsWith('mcp__');
}

function parseJsonOrEmpty(raw: string): unknown {
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // The SDK can deliver partial JSON if the stream is cut short; preserve
    // whatever we captured rather than dropping the tool call entirely.
    return { __raw: raw };
  }
}

/**
 * Compute cost (USD) from token usage and model id.
 *
 * Honest defaults: unknown models return `null` so downstream metering does
 * not record fabricated numbers. The table is intentionally small; it can be
 * expanded as new models ship.
 */
export function computeCost(usage: AnthropicUsage | undefined, model: string): number | null {
  if (usage === undefined) return null;
  const rates = COST_TABLE[model];
  if (rates === undefined) return null;
  const inputTok = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
  const outputTok = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
  // cache_creation_input_tokens is billed like normal input (slightly higher in
  // reality, but the precise multiplier varies; treat as input for honesty).
  // cache_read_input_tokens is much cheaper (~10%); treat as 10% of input rate.
  const cacheCreate =
    typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0;
  const cacheRead =
    typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0;
  const millionth = 1 / 1_000_000;
  return (
    (inputTok + cacheCreate) * rates.input * millionth +
    cacheRead * rates.input * 0.1 * millionth +
    outputTok * rates.output * millionth
  );
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
