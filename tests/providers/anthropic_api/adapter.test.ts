import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AnthropicApiProvider, register } from '../../../src/providers/anthropic_api/index.js';
import type {
  AnthropicFinalMessage,
  AnthropicLike,
  AnthropicMessageStream,
  AnthropicStreamEvent,
  AnthropicStreamParams,
} from '../../../src/providers/anthropic_api/types.js';
import {
  _resetRegistryForTests,
  defaultCapabilitiesFor,
  getProvider,
  type RunEvent,
} from '../../../src/core/providers/index.js';

interface CapturedCall {
  params: AnthropicStreamParams;
}

function makeFakeClient(
  events: AnthropicStreamEvent[],
  final: AnthropicFinalMessage,
  opts: {
    onCall?: (call: CapturedCall) => void;
    yieldGapMs?: number;
    throwOnStream?: Error;
    throwOnFinal?: Error;
  } = {},
): { client: AnthropicLike; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const client: AnthropicLike = {
    messages: {
      stream(params: AnthropicStreamParams): AnthropicMessageStream {
        const call: CapturedCall = { params };
        calls.push(call);
        opts.onCall?.(call);

        if (opts.throwOnStream) throw opts.throwOnStream;

        const stream: AnthropicMessageStream = {
          async *[Symbol.asyncIterator](): AsyncGenerator<AnthropicStreamEvent, void, void> {
            for (const ev of events) {
              yield ev;
              // microtask gap to let abort signals propagate between yields
              await Promise.resolve();
            }
          },
          async finalMessage(): Promise<AnthropicFinalMessage> {
            if (opts.throwOnFinal) throw opts.throwOnFinal;
            return final;
          },
        };
        return stream;
      },
    },
  };
  return { client, calls };
}

async function collect(stream: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'sk-test-key';
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY;
  _resetRegistryForTests();
});

describe('AnthropicApiProvider.run — happy path streaming', () => {
  it('assembles text deltas into a single message event then yields done', async () => {
    const { client, calls } = makeFakeClient(
      [
        { type: 'message_start' },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hello ' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'world!' },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_stop' },
      ],
      {
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    );

    const provider = new AnthropicApiProvider({ clientFactory: () => client });
    const events = await collect(
      provider.run({
        agentId: 'test',
        goal: 'Greet me',
        instructions: 'You greet the user.',
        workspaceRoot: '/tmp',
      }),
    );

    const types = events.map((e) => e.type);
    expect(types).toEqual(['message', 'done']);

    expect(events[0]).toMatchObject({
      type: 'message',
      role: 'assistant',
      text: 'Hello world!',
    });

    const done = events[1] as Extract<RunEvent, { type: 'done' }>;
    expect(done.reason).toBe('completed');
    expect(done.tokens).toEqual({ input: 100, output: 50 });
    // Default model `claude-sonnet-4-6` has rates so cost should be numeric.
    expect(typeof done.cost).toBe('number');
    expect(done.durationMs).toBeGreaterThanOrEqual(0);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.params.model).toBe('claude-sonnet-4-6');
  });
});

describe('AnthropicApiProvider.run — tool use', () => {
  it('emits a tool_call event with the parsed input JSON', async () => {
    const { client } = makeFakeClient(
      [
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 't1', name: 'Read', input: {} },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"path":' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '"/a"}' },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_stop' },
      ],
      {
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    );

    const provider = new AnthropicApiProvider({ clientFactory: () => client });
    const events = await collect(
      provider.run({
        agentId: 'test',
        goal: 'read a',
        instructions: 'sys',
        workspaceRoot: '/tmp',
        allowedTools: ['Read'],
      }),
    );

    expect(events.map((e) => e.type)).toEqual(['tool_call', 'done']);
    expect(events[0]).toMatchObject({
      type: 'tool_call',
      toolCallId: 't1',
      tool: 'Read',
      args: { path: '/a' },
    });
    const done = events[1] as Extract<RunEvent, { type: 'done' }>;
    expect(done.reason).toBe('completed');
  });
});

describe('AnthropicApiProvider.run — missing API key', () => {
  it('yields error then done(error) without throwing when env var is unset', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    let factoryCalled = false;
    const provider = new AnthropicApiProvider({
      clientFactory: () => {
        factoryCalled = true;
        throw new Error('should not be called');
      },
    });

    const events = await collect(
      provider.run({
        agentId: 'test',
        goal: 'hi',
        instructions: '',
        workspaceRoot: '/tmp',
      }),
    );

    expect(factoryCalled).toBe(false);
    expect(events.map((e) => e.type)).toEqual(['error', 'done']);
    expect(events[0]).toMatchObject({
      type: 'error',
      message: 'ANTHROPIC_API_KEY not set',
      recoverable: false,
    });
    expect(events[1]).toMatchObject({ type: 'done', reason: 'error' });
  });

  it('treats an empty string as unset', async () => {
    process.env.ANTHROPIC_API_KEY = '';
    const provider = new AnthropicApiProvider({
      clientFactory: () => {
        throw new Error('should not be called');
      },
    });

    const events = await collect(
      provider.run({
        agentId: 'test',
        goal: 'hi',
        instructions: '',
        workspaceRoot: '/tmp',
      }),
    );

    expect(events.map((e) => e.type)).toEqual(['error', 'done']);
  });
});

describe('AnthropicApiProvider.run — cancellation', () => {
  it('yields done(cancelled) when the AbortSignal fires mid-stream', async () => {
    const controller = new AbortController();
    const { client } = makeFakeClient(
      [
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'one' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'text', text: '' },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: 'two' },
        },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_stop' },
      ],
      {
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    );

    const provider = new AnthropicApiProvider({ clientFactory: () => client });
    const stream = provider.run({
      agentId: 'test',
      goal: 'go',
      instructions: '',
      workspaceRoot: '/tmp',
      signal: controller.signal,
    });

    const collected: RunEvent[] = [];
    for await (const event of stream) {
      collected.push(event);
      if (event.type === 'message') controller.abort();
    }

    const last = collected[collected.length - 1];
    expect(last).toMatchObject({ type: 'done', reason: 'cancelled' });
    expect(collected.filter((e) => e.type === 'done')).toHaveLength(1);
  });
});

describe('AnthropicApiProvider.run — prompt caching', () => {
  it('passes system prompt with cache_control: ephemeral by default', async () => {
    const { client, calls } = makeFakeClient([{ type: 'message_stop' }], {
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
    });

    const provider = new AnthropicApiProvider({ clientFactory: () => client });
    await collect(
      provider.run({
        agentId: 'test',
        goal: 'go',
        instructions: 'You are a helpful agent.',
        workspaceRoot: '/tmp',
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.params.system).toEqual([
      {
        type: 'text',
        text: 'You are a helpful agent.',
        cache_control: { type: 'ephemeral' },
      },
    ]);
  });
});

describe('AnthropicApiProvider.run — tool filtering', () => {
  it('strips MCP-namespaced tool ids and emits stub schemas for builtins', async () => {
    const { client, calls } = makeFakeClient([{ type: 'message_stop' }], {
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
    });

    const provider = new AnthropicApiProvider({ clientFactory: () => client });
    await collect(
      provider.run({
        agentId: 'test',
        goal: 'go',
        instructions: '',
        workspaceRoot: '/tmp',
        allowedTools: ['Read', 'Bash', 'mcp.gmail.send', 'mcp__slack__post'],
      }),
    );

    const tools = calls[0]?.params.tools;
    expect(tools).toBeDefined();
    const names = (tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual(['Bash', 'Read']);
    for (const tool of tools ?? []) {
      expect(tool.input_schema).toMatchObject({
        type: 'object',
        additionalProperties: true,
      });
    }
  });
});

describe('AnthropicApiProvider capabilities + registration', () => {
  it('capabilities match defaultCapabilitiesFor(anthropic_api) exactly', () => {
    const provider = new AnthropicApiProvider();
    expect(provider.capabilities).toEqual(defaultCapabilitiesFor('anthropic_api'));
  });

  it('register() wires the factory into the central registry', () => {
    register({ clientFactory: () => ({ messages: { stream: () => ({}) as never } }) });
    const resolved = getProvider('anthropic_api');
    expect(resolved.id).toBe('anthropic_api');
    expect(resolved.capabilities).toEqual(defaultCapabilitiesFor('anthropic_api'));
  });
});

describe('AnthropicApiProvider.run — defaultModel option', () => {
  it('uses the provided default model when input.model is absent', async () => {
    const { client, calls } = makeFakeClient([{ type: 'message_stop' }], {
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
    });

    const provider = new AnthropicApiProvider({
      clientFactory: () => client,
      defaultModel: 'claude-opus-4-7',
    });
    await collect(
      provider.run({
        agentId: 'test',
        goal: 'go',
        instructions: '',
        workspaceRoot: '/tmp',
      }),
    );

    expect(calls[0]?.params.model).toBe('claude-opus-4-7');
  });

  it('honours input.model over the default', async () => {
    const { client, calls } = makeFakeClient([{ type: 'message_stop' }], {
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
    });

    const provider = new AnthropicApiProvider({ clientFactory: () => client });
    await collect(
      provider.run({
        agentId: 'test',
        goal: 'go',
        instructions: '',
        workspaceRoot: '/tmp',
        model: 'claude-haiku-4-5-20251001',
      }),
    );

    expect(calls[0]?.params.model).toBe('claude-haiku-4-5-20251001');
  });
});
