import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultCapabilitiesFor } from '../../../src/core/providers/capabilities.js';
import { _resetRegistryForTests, getProvider } from '../../../src/core/providers/factory.js';
import {
  OpenAiApiProvider,
  type OpenAiChunk,
  type OpenAiCreateParams,
  type OpenAiLike,
  type OpenAiStream,
} from '../../../src/providers/openai_api/adapter.js';
import { register } from '../../../src/providers/openai_api/index.js';
import type { AgentRunInput, RunEvent } from '../../../src/core/providers/index.js';

interface CapturedCall {
  params: OpenAiCreateParams;
}

function makeFakeClient(
  scripted: OpenAiChunk[],
  opts: { delayPerChunk?: boolean } = {},
): { client: OpenAiLike; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const client: OpenAiLike = {
    chat: {
      completions: {
        create: (params: OpenAiCreateParams): OpenAiStream => {
          calls.push({ params });
          const stream: OpenAiStream = {
            async *[Symbol.asyncIterator](): AsyncGenerator<OpenAiChunk, void, void> {
              for (const chunk of scripted) {
                if (opts.delayPerChunk === true) await Promise.resolve();
                yield chunk;
              }
            },
          };
          return stream;
        },
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

function baseInput(overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    agentId: 'test-agent',
    goal: 'do the thing',
    instructions: 'you are a test agent',
    workspaceRoot: '/tmp/ws',
    ...overrides,
  };
}

let originalKey: string | undefined;

beforeEach(() => {
  originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-test-key';
  _resetRegistryForTests();
});

afterEach(() => {
  if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalKey;
  _resetRegistryForTests();
});

describe('OpenAiApiProvider.run', () => {
  it('translates a scripted content stream into message + done(completed)', async () => {
    const { client } = makeFakeClient([
      { choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello, ' } }] },
      { choices: [{ index: 0, delta: { content: 'world!' }, finish_reason: 'stop' }] },
      {
        choices: [],
        usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
      },
    ]);

    const provider = new OpenAiApiProvider({ clientFactory: () => client });
    const events = await collect(provider.run(baseInput()));

    const msg = events.find((e) => e.type === 'message');
    expect(msg).toMatchObject({ type: 'message', role: 'assistant', text: 'Hello, world!' });

    const done = events.find((e) => e.type === 'done');
    expect(done).toMatchObject({
      type: 'done',
      reason: 'completed',
      tokens: { input: 12, output: 5 },
    });
  });

  it('emits a tool_call with original dotted id when a function call streams in', async () => {
    const { client, calls } = makeFakeClient([
      {
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'call_abc',
                  type: 'function',
                  function: { name: 'fs_read', arguments: '{"path":' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: '"/a"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      { choices: [], usage: { prompt_tokens: 8, completion_tokens: 3 } },
    ]);

    const provider = new OpenAiApiProvider({ clientFactory: () => client });
    const events = await collect(provider.run(baseInput({ allowedTools: ['fs.read'] })));

    const call = events.find((e) => e.type === 'tool_call');
    expect(call).toMatchObject({
      type: 'tool_call',
      toolCallId: 'call_abc',
      tool: 'fs.read',
      args: { path: '/a' },
    });

    // Tool was passed with the rewritten OpenAI-safe name.
    expect(calls[0].params.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'fs_read',
          description: 'Agent OS tool: fs.read',
          parameters: { type: 'object', properties: {}, additionalProperties: true },
        },
      },
    ]);

    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'completed' });
  });

  it('yields error + done(error) when OPENAI_API_KEY is not set, without throwing', async () => {
    delete process.env.OPENAI_API_KEY;
    const { client } = makeFakeClient([]);
    const provider = new OpenAiApiProvider({ clientFactory: () => client });

    const events = await collect(provider.run(baseInput()));

    expect(events[0]).toMatchObject({
      type: 'error',
      message: 'OPENAI_API_KEY not set',
      recoverable: false,
    });
    expect(events[1]).toMatchObject({ type: 'done', reason: 'error' });
  });

  it('honours an aborted signal mid-stream', async () => {
    const controller = new AbortController();
    const { client } = makeFakeClient(
      [
        { choices: [{ index: 0, delta: { content: 'partial' } }] },
        { choices: [{ index: 0, delta: { content: 'more' } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ],
      { delayPerChunk: true },
    );

    // Wrap the client so we can fire abort after the first chunk is read.
    const wrapped: OpenAiLike = {
      chat: {
        completions: {
          create: (params: OpenAiCreateParams): OpenAiStream => {
            const inner = client.chat.completions.create(params) as OpenAiStream;
            return {
              async *[Symbol.asyncIterator](): AsyncGenerator<OpenAiChunk, void, void> {
                let count = 0;
                for await (const chunk of inner) {
                  yield chunk;
                  count += 1;
                  if (count === 1) controller.abort();
                }
              },
            };
          },
        },
      },
    };

    const provider = new OpenAiApiProvider({ clientFactory: () => wrapped });
    const events = await collect(provider.run(baseInput({ signal: controller.signal })));

    const done = events.find((e) => e.type === 'done');
    expect(done).toMatchObject({ type: 'done', reason: 'cancelled' });
  });

  it('exposes capabilities that match defaultCapabilitiesFor("openai_api")', () => {
    const provider = new OpenAiApiProvider();
    expect(provider.capabilities).toEqual(defaultCapabilitiesFor('openai_api'));
    expect(provider.capabilities.mcp).toBe(false);
    expect(provider.capabilities.promptCaching).toBe(false);
  });

  it('skips mcp.* tool ids when building the OpenAI tools array', async () => {
    const { client, calls } = makeFakeClient([
      { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] },
    ]);
    const provider = new OpenAiApiProvider({ clientFactory: () => client });
    await collect(
      provider.run(baseInput({ allowedTools: ['fs.read', 'mcp.crawlforge.search_web'] })),
    );

    const toolNames = (calls[0].params.tools ?? []).map((t) => t.function.name);
    expect(toolNames).toEqual(['fs_read']);
  });
});

describe('register()', () => {
  it('registers the provider so getProvider("openai_api") returns an instance', () => {
    const { client } = makeFakeClient([]);
    register({ clientFactory: () => client });
    const provider = getProvider('openai_api');
    expect(provider).toBeInstanceOf(OpenAiApiProvider);
    expect(provider.id).toBe('openai_api');
  });
});
