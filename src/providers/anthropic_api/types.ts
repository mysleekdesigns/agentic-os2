/**
 * Internal types for the `anthropic_api` provider (PRD §2.2, Phase 11).
 *
 * These mirror only the slice of the Anthropic SDK surface the adapter
 * actually consumes. Keeping the structural shape narrow lets tests inject
 * a hand-rolled fake without depending on the SDK's full type graph.
 */

/** Shape of a content block streamed by the Messages API. */
export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown };

/** A single stream event emitted by `client.messages.stream(...)`. */
export type AnthropicStreamEvent =
  | { type: 'message_start'; message?: unknown }
  | { type: 'content_block_start'; index: number; content_block: AnthropicContentBlock }
  | {
      type: 'content_block_delta';
      index: number;
      delta:
        | { type: 'text_delta'; text: string }
        | { type: 'input_json_delta'; partial_json: string };
    }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta?: unknown; usage?: AnthropicUsage }
  | { type: 'message_stop' };

/** Usage block returned on the final message. */
export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** Final message returned by `stream.finalMessage()`. */
export interface AnthropicFinalMessage {
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | string;
  usage: AnthropicUsage;
  content?: AnthropicContentBlock[];
}

/**
 * Minimal structural type for the Anthropic SDK client. Only the methods the
 * adapter actually calls are declared so tests can inject a tiny fake.
 */
export interface AnthropicLike {
  messages: {
    stream: (params: AnthropicStreamParams) => AnthropicMessageStream;
  };
}

/** Subset of `MessageStreamParams` the adapter forwards. */
export interface AnthropicStreamParams {
  model: string;
  max_tokens: number;
  system?: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>;
  messages: Array<{ role: 'user' | 'assistant'; content: string | unknown[] }>;
  tools?: Array<{
    name: string;
    description?: string;
    input_schema: {
      type: 'object';
      properties: Record<string, unknown>;
      additionalProperties?: boolean;
    };
  }>;
}

/** Async-iterable stream returned by `messages.stream`. */
export interface AnthropicMessageStream extends AsyncIterable<AnthropicStreamEvent> {
  finalMessage(): Promise<AnthropicFinalMessage>;
}
