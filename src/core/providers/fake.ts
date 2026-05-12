/**
 * In-process scripted Provider for tests (PRD §2.2, Phase 3 Bundle A).
 *
 * `FakeProvider` impersonates `claude_code_local` so test fixtures and the
 * CLI can exercise the full RunEvent pipeline without spinning up the SDK.
 * Scripts are constructed via the `scriptedTranscript()` builder.
 */

import { defaultCapabilitiesFor } from './capabilities.js';
import type { AgentRunInput, Capabilities, Provider, RunEvent } from './types.js';

export interface FakeProviderOptions {
  /** Events to yield in order. A trailing `done` is appended if missing. */
  events: RunEvent[];
  /** Override individual capability flags (defaults match `claude_code_local`). */
  capabilities?: Partial<Capabilities>;
  /** Wall-clock delay between yielded events, in milliseconds. Defaults to 0. */
  delayMs?: number;
}

/** Test-only `Provider` whose stream is fully scripted ahead of time. */
export class FakeProvider implements Provider {
  readonly id = 'claude_code_local' as const;
  readonly capabilities: Capabilities;
  private readonly events: RunEvent[];
  private readonly delayMs: number;

  constructor(opts: FakeProviderOptions) {
    this.events = [...opts.events];
    this.delayMs = opts.delayMs ?? 0;
    this.capabilities = {
      ...defaultCapabilitiesFor('claude_code_local'),
      ...(opts.capabilities ?? {}),
    };
  }

  run(input: AgentRunInput): AsyncIterable<RunEvent> {
    const start = Date.now();
    const events = this.events;
    const delayMs = this.delayMs;
    const signal = input.signal;

    async function* iterator(): AsyncGenerator<RunEvent, void, void> {
      let sawDone = false;
      for (const event of events) {
        if (signal?.aborted) {
          yield {
            type: 'done',
            reason: 'cancelled',
            cost: null,
            tokens: null,
            durationMs: Date.now() - start,
            timestamp: Date.now(),
          };
          return;
        }
        if (delayMs > 0) {
          await sleep(delayMs, signal);
          if (signal?.aborted) {
            yield {
              type: 'done',
              reason: 'cancelled',
              cost: null,
              tokens: null,
              durationMs: Date.now() - start,
              timestamp: Date.now(),
            };
            return;
          }
        }
        yield event;
        if (event.type === 'done') {
          sawDone = true;
        }
      }
      if (!sawDone) {
        yield {
          type: 'done',
          reason: 'completed',
          cost: null,
          tokens: null,
          durationMs: Date.now() - start,
          timestamp: Date.now(),
        };
      }
    }

    return iterator();
  }
}

/**
 * Fluent builder for `RunEvent[]` used by tests. Every method bumps a shared
 * monotonically increasing timestamp so transcripts are ordering-stable
 * without callers having to think about clocks.
 */
export interface ScriptedTranscriptBuilder {
  message(role: 'assistant' | 'user', text: string): ScriptedTranscriptBuilder;
  toolCall(tool: string, args: unknown, toolCallId?: string): ScriptedTranscriptBuilder;
  toolResult(
    result: unknown,
    opts?: { toolCallId?: string; isError?: boolean },
  ): ScriptedTranscriptBuilder;
  approvalRequested(
    tool: string,
    args: unknown,
    opts?: { toolCallId?: string; reason?: string },
  ): ScriptedTranscriptBuilder;
  error(message: string, recoverable?: boolean): ScriptedTranscriptBuilder;
  done(
    opts?: Partial<{
      reason: 'completed' | 'cancelled' | 'error';
      cost: number | null;
      tokens: { input: number | null; output: number | null } | null;
      durationMs: number;
    }>,
  ): ScriptedTranscriptBuilder;
  build(): RunEvent[];
}

/** Construct a new transcript builder. See `ScriptedTranscriptBuilder`. */
export function scriptedTranscript(): ScriptedTranscriptBuilder {
  const events: RunEvent[] = [];
  let tick = 0;
  let toolCallCounter = 0;
  // Track the most recent tool_call id so `toolResult()` can default to it.
  let lastToolCallId: string | undefined;
  const now = (): number => {
    tick += 1;
    return tick;
  };
  const nextToolCallId = (): string => {
    toolCallCounter += 1;
    return `tc_${toolCallCounter}`;
  };

  const builder: ScriptedTranscriptBuilder = {
    message(role, text) {
      events.push({ type: 'message', role, text, timestamp: now() });
      return builder;
    },
    toolCall(tool, args, toolCallId) {
      const id = toolCallId ?? nextToolCallId();
      lastToolCallId = id;
      events.push({ type: 'tool_call', toolCallId: id, tool, args, timestamp: now() });
      return builder;
    },
    toolResult(result, opts = {}) {
      const id = opts.toolCallId ?? lastToolCallId ?? nextToolCallId();
      const event: RunEvent = {
        type: 'tool_result',
        toolCallId: id,
        result,
        timestamp: now(),
        ...(opts.isError !== undefined ? { isError: opts.isError } : {}),
      };
      events.push(event);
      return builder;
    },
    approvalRequested(tool, args, opts = {}) {
      const id = opts.toolCallId ?? nextToolCallId();
      lastToolCallId = id;
      const event: RunEvent = {
        type: 'approval_requested',
        toolCallId: id,
        tool,
        args,
        timestamp: now(),
        ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      };
      events.push(event);
      return builder;
    },
    error(message, recoverable) {
      const event: RunEvent = {
        type: 'error',
        message,
        timestamp: now(),
        ...(recoverable !== undefined ? { recoverable } : {}),
      };
      events.push(event);
      return builder;
    },
    done(opts = {}) {
      events.push({
        type: 'done',
        reason: opts.reason ?? 'completed',
        cost: opts.cost ?? null,
        tokens: opts.tokens ?? null,
        durationMs: opts.durationMs ?? 0,
        timestamp: now(),
      });
      return builder;
    },
    build() {
      return [...events];
    },
  };

  return builder;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
