import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ClaudeCodeLocalProvider } from '../../../src/providers/claude_code_local/adapter.js';
import type { RunEvent } from '../../../src/core/providers/index.js';

interface CapturedCall {
  prompt: string;
  options: Record<string, unknown>;
  envSnapshot: Record<string, string | undefined>;
}

function makeFakeSdk(
  messages: unknown[],
  opts: {
    throwAfter?: number;
    onCall?: (call: CapturedCall) => void;
  } = {},
) {
  const calls: CapturedCall[] = [];

  const sdkImport = async (): Promise<{
    query: (params: {
      prompt: string;
      options?: Record<string, unknown>;
    }) => AsyncIterable<unknown>;
  }> => ({
    query: (params: { prompt: string; options?: Record<string, unknown> }) => {
      const call: CapturedCall = {
        prompt: params.prompt,
        options: params.options ?? {},
        envSnapshot: {
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
          CLAUDE_API_KEY: process.env.CLAUDE_API_KEY,
          OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        },
      };
      calls.push(call);
      opts.onCall?.(call);

      let interrupted = false;
      const iter = {
        async *[Symbol.asyncIterator](): AsyncGenerator<unknown, void, void> {
          for (let i = 0; i < messages.length; i++) {
            if (interrupted) return;
            if (opts.throwAfter !== undefined && i === opts.throwAfter) {
              throw new Error('synthetic stream failure');
            }
            yield messages[i];
            // Microtask gap lets abort signals propagate between yields.
            await Promise.resolve();
          }
        },
        interrupt: async (): Promise<void> => {
          interrupted = true;
        },
      };
      return iter;
    },
  });

  return { sdkImport, calls };
}

async function collect(stream: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'agent-os-adapter-'));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe('ClaudeCodeLocalProvider.run', () => {
  it('translates a scripted SDK transcript into the expected RunEvent sequence', async () => {
    const { sdkImport } = makeFakeSdk([
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Looking at the file.' }] },
      },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'a.txt' } }],
        },
      },
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'hello' }],
        },
      },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Done.' }] },
      },
      { type: 'result', subtype: 'success', total_cost_usd: 0.01 },
    ]);

    const provider = new ClaudeCodeLocalProvider({ sdkImport });
    const events = await collect(
      provider.run({
        agentId: 'test',
        goal: 'read a file',
        instructions: 'You are a test agent.',
        workspaceRoot: workspace,
      }),
    );

    const types = events.map((e) => e.type);
    expect(types).toEqual(['message', 'tool_call', 'tool_result', 'message', 'done']);

    const done = events[events.length - 1];
    expect(done).toMatchObject({
      type: 'done',
      reason: 'completed',
      cost: null,
      tokens: null,
    });
    expect(typeof (done as { durationMs: number }).durationMs).toBe('number');

    expect(events[0]).toMatchObject({
      type: 'message',
      role: 'assistant',
      text: 'Looking at the file.',
    });
    expect(events[1]).toMatchObject({ type: 'tool_call', toolCallId: 'toolu_1', tool: 'Read' });
    expect(events[2]).toMatchObject({
      type: 'tool_result',
      toolCallId: 'toolu_1',
      result: 'hello',
    });
    expect(events[3]).toMatchObject({ type: 'message', role: 'assistant', text: 'Done.' });
  });

  it('honours an aborted signal mid-stream and yields done with reason cancelled', async () => {
    const controller = new AbortController();
    const { sdkImport } = makeFakeSdk([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'one' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'two' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'three' }] } },
      { type: 'result', subtype: 'success' },
    ]);

    const provider = new ClaudeCodeLocalProvider({ sdkImport });
    const stream = provider.run({
      agentId: 'test',
      goal: 'go',
      instructions: '',
      workspaceRoot: workspace,
      signal: controller.signal,
    });

    const collected: RunEvent[] = [];
    for await (const event of stream) {
      collected.push(event);
      if (collected.length === 1) controller.abort();
    }

    const last = collected[collected.length - 1];
    expect(last).toMatchObject({ type: 'done', reason: 'cancelled', cost: null, tokens: null });
    // No event must follow `done`.
    expect(collected.filter((e) => e.type === 'done')).toHaveLength(1);
  });

  it('emits error then done(error) when the SDK stream throws mid-flight', async () => {
    const { sdkImport } = makeFakeSdk(
      [
        { type: 'assistant', message: { content: [{ type: 'text', text: 'starting' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'never reached' }] } },
      ],
      { throwAfter: 1 },
    );

    const provider = new ClaudeCodeLocalProvider({ sdkImport });
    const events = await collect(
      provider.run({
        agentId: 'test',
        goal: 'go',
        instructions: '',
        workspaceRoot: workspace,
      }),
    );

    const errorIdx = events.findIndex((e) => e.type === 'error');
    const doneIdx = events.findIndex((e) => e.type === 'done');
    expect(errorIdx).toBeGreaterThanOrEqual(0);
    expect(doneIdx).toBeGreaterThan(errorIdx);
    expect(events[doneIdx]).toMatchObject({
      type: 'done',
      reason: 'error',
      cost: null,
      tokens: null,
    });
  });

  it('does not read API keys from env and leaves env untouched', async () => {
    const sentinel = 'sk-sentinel-DO-NOT-USE';
    const before = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = sentinel;

    try {
      const { sdkImport, calls } = makeFakeSdk([{ type: 'result', subtype: 'success' }]);
      const provider = new ClaudeCodeLocalProvider({ sdkImport });
      await collect(
        provider.run({
          agentId: 'test',
          goal: 'go',
          instructions: '',
          workspaceRoot: workspace,
        }),
      );

      // Adapter must not have stuffed the key into the SDK options.
      expect(JSON.stringify(calls[0]?.options)).not.toContain(sentinel);
      // And the env var is untouched (no clobbering).
      expect(process.env.ANTHROPIC_API_KEY).toBe(sentinel);
    } finally {
      if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = before;
    }
  });

  it('still runs when no API key env vars are set (Max-plan path)', async () => {
    const saved = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      CLAUDE_API_KEY: process.env.CLAUDE_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      const { sdkImport } = makeFakeSdk([
        { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
        { type: 'result', subtype: 'success' },
      ]);
      const provider = new ClaudeCodeLocalProvider({ sdkImport });
      const events = await collect(
        provider.run({
          agentId: 'test',
          goal: 'go',
          instructions: '',
          workspaceRoot: workspace,
        }),
      );
      expect(events[events.length - 1]).toMatchObject({ type: 'done', reason: 'completed' });
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('passes MCP servers from .mcp.json through to the SDK', async () => {
    await writeFile(
      join(workspace, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          fs: { command: 'node', args: ['./server.js'], env: { X: '1' } },
        },
      }),
    );
    // Disable pinning explicitly — without a config the new fail-closed default
    // would drop this unchecksummed server.
    await writeFile(
      join(workspace, 'agent-os.config.yaml'),
      'security:\n  pinned_mcp_servers: false\n',
    );

    const { sdkImport, calls } = makeFakeSdk([{ type: 'result', subtype: 'success' }]);
    const provider = new ClaudeCodeLocalProvider({ sdkImport });
    await collect(
      provider.run({
        agentId: 'test',
        goal: 'go',
        instructions: '',
        workspaceRoot: workspace,
      }),
    );

    expect(calls[0]?.options.mcpServers).toEqual({
      fs: { command: 'node', args: ['./server.js'], env: { X: '1' } },
    });
  });

  it('prefers caller-supplied mcpServers over .mcp.json', async () => {
    await writeFile(
      join(workspace, '.mcp.json'),
      JSON.stringify({ mcpServers: { fs: { command: 'never-used' } } }),
    );
    const override = { custom: { command: 'echo' } };

    const { sdkImport, calls } = makeFakeSdk([{ type: 'result', subtype: 'success' }]);
    const provider = new ClaudeCodeLocalProvider({ sdkImport });
    await collect(
      provider.run({
        agentId: 'test',
        goal: 'go',
        instructions: '',
        workspaceRoot: workspace,
        mcpServers: override,
      }),
    );

    expect(calls[0]?.options.mcpServers).toBe(override);
  });

  it('passes instructions through appendSystemPrompt and goal through prompt', async () => {
    const { sdkImport, calls } = makeFakeSdk([{ type: 'result', subtype: 'success' }]);
    const provider = new ClaudeCodeLocalProvider({ sdkImport });
    await collect(
      provider.run({
        agentId: 'test',
        goal: 'do the thing',
        instructions: 'You are a careful assistant.',
        workspaceRoot: workspace,
      }),
    );

    expect(calls[0]?.prompt).toBe('do the thing');
    expect(calls[0]?.options.appendSystemPrompt).toBe('You are a careful assistant.');
  });

  it('passes allowedTools through unchanged', async () => {
    const { sdkImport, calls } = makeFakeSdk([{ type: 'result', subtype: 'success' }]);
    const provider = new ClaudeCodeLocalProvider({ sdkImport });
    await collect(
      provider.run({
        agentId: 'test',
        goal: 'go',
        instructions: '',
        workspaceRoot: workspace,
        allowedTools: ['Read', 'Grep'],
      }),
    );
    expect(calls[0]?.options.allowedTools).toEqual(['Read', 'Grep']);
  });

  it('surfaces a clear error if the SDK import itself fails', async () => {
    const sdkImport = async (): Promise<never> => {
      throw new Error('module not found');
    };
    const provider = new ClaudeCodeLocalProvider({ sdkImport });
    const events = await collect(
      provider.run({
        agentId: 'test',
        goal: 'go',
        instructions: '',
        workspaceRoot: workspace,
      }),
    );

    expect(events[0]).toMatchObject({ type: 'error' });
    expect(events[events.length - 1]).toMatchObject({ type: 'done', reason: 'error' });
  });

  it('exposes honest capabilities — costMetering and promptCaching false', () => {
    const provider = new ClaudeCodeLocalProvider({
      sdkImport: async () =>
        ({ query: () => ({ [Symbol.asyncIterator]: async function* () {} }) }) as never,
    });
    expect(provider.id).toBe('claude_code_local');
    expect(provider.capabilities.costMetering).toBe(false);
    expect(provider.capabilities.promptCaching).toBe(false);
    expect(provider.capabilities.mcp).toBe(true);
    expect(provider.capabilities.streaming).toBe(true);
  });
});
