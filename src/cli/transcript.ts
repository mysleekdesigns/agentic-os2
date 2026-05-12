/**
 * Pure renderer functions for provider `RunEvent` streams.
 *
 * The CLI command (`agent-os run`) drives the stream and writes to stdout;
 * everything in this file is string-in / string-out so it can be unit-tested
 * without spying on filesystems or terminals. No third-party formatting deps
 * (chalk, ansi-styles, …) — colour, when enabled, is emitted as raw ANSI
 * escape sequences.
 *
 * Honest rendering rule (PRD §1.5): `cost: null` and `tokens: null` MUST render
 * as the em-dash `—`, never `0` or any other fabricated value.
 *
 * Canonical reference: PRD §2.2 (RunEvent surface) and Phase 3.
 */

import type { RunEvent } from '../core/providers/index.js';

/** Options accepted by `renderEvent`. */
export interface RenderOptions {
  /** Whether to wrap output in ANSI colour codes. Default: `false`. */
  color?: boolean;
}

// ---------------------------------------------------------------------------
// ANSI colour helpers
// ---------------------------------------------------------------------------

const ANSI_RESET = '\x1b[0m';
const ANSI_DIM = '\x1b[2m';
const ANSI_BOLD = '\x1b[1m';
const ANSI_RED = '\x1b[31m';
const ANSI_GREEN = '\x1b[32m';
const ANSI_YELLOW = '\x1b[33m';
const ANSI_CYAN = '\x1b[36m';

function paint(text: string, code: string, color: boolean): string {
  return color ? `${code}${text}${ANSI_RESET}` : text;
}

// ---------------------------------------------------------------------------
// Value formatting
// ---------------------------------------------------------------------------

/**
 * Stringify a tool-call argument bag so it fits on one line. We do a best-effort
 * `JSON.stringify` and then squash any newline / extra whitespace runs the JSON
 * encoder might emit for strings containing newlines.
 */
function oneLineArgs(args: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(args);
  } catch {
    return '<unserialisable>';
  }
  if (json === undefined) return '';
  return json.replace(/\s+/g, ' ');
}

/** Format the trailing newline-separated multi-line message body cleanly. */
function trimTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

/** Honest render of a nullable numeric metric. PRD §1.5. */
function renderNullableNumber(value: number | null): string {
  if (value === null) return '—';
  // Coalesce integers to integer strings; preserve fractional precision for
  // floats. We don't aggressively round — caller controls precision.
  return Number.isInteger(value) ? String(value) : String(value);
}

function renderTokens(tokens: { input: number | null; output: number | null } | null): string {
  if (tokens === null) return '—';
  const inp = renderNullableNumber(tokens.input);
  const out = renderNullableNumber(tokens.output);
  return `in=${inp} out=${out}`;
}

// ---------------------------------------------------------------------------
// Per-event renderers
// ---------------------------------------------------------------------------

function renderMessage(event: Extract<RunEvent, { type: 'message' }>, color: boolean): string {
  const label = paint(event.role, event.role === 'assistant' ? ANSI_CYAN : ANSI_DIM, color);
  return `  → ${label}: ${trimTrailingNewline(event.text)}`;
}

function renderToolCall(event: Extract<RunEvent, { type: 'tool_call' }>, color: boolean): string {
  const bullet = paint('•', ANSI_DIM, color);
  const tool = paint(event.tool, ANSI_BOLD, color);
  const args = oneLineArgs(event.args);
  return `  ${bullet} tool_call ${tool}(${args})`;
}

function renderToolResult(
  event: Extract<RunEvent, { type: 'tool_result' }>,
  color: boolean,
): string {
  if (event.isError === true) {
    const cross = paint('✗', ANSI_RED, color);
    // Tool name is not on the tool_result event by spec; we surface the id so
    // operators can correlate with the preceding tool_call line.
    return `  ${cross} tool_result ${event.toolCallId} (error)`;
  }
  const check = paint('✓', ANSI_GREEN, color);
  return `  ${check} tool_result ${event.toolCallId}`;
}

function renderApprovalRequested(
  event: Extract<RunEvent, { type: 'approval_requested' }>,
  color: boolean,
): string {
  const pause = paint('⏸', ANSI_YELLOW, color);
  const tool = paint(event.tool, ANSI_BOLD, color);
  const reason = event.reason !== undefined && event.reason.length > 0 ? ` — ${event.reason}` : '';
  return `  ${pause} approval_requested ${tool}${reason}`;
}

function renderError(event: Extract<RunEvent, { type: 'error' }>, color: boolean): string {
  const cross = paint('✗', ANSI_RED, color);
  return `  ${cross} error: ${event.message}`;
}

function renderDone(event: Extract<RunEvent, { type: 'done' }>, color: boolean): string {
  const reasonText = `— done (${event.reason}) in ${event.durationMs}ms`;
  const reasonColour =
    event.reason === 'completed'
      ? ANSI_GREEN
      : event.reason === 'cancelled'
        ? ANSI_YELLOW
        : ANSI_RED;
  const header = paint(reasonText, reasonColour, color);
  const metrics = `   cost: ${renderNullableNumber(event.cost)}  tokens: ${renderTokens(event.tokens)}`;
  return `\n${header}\n${metrics}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render a single `RunEvent` to a human-readable string. Output never ends in
 * a trailing newline — the CLI command is responsible for separating events.
 *
 * Renderers are pure: they do not touch stdout, the terminal, or any global
 * state. The caller decides whether to enable colour (via `process.stdout.isTTY`
 * or a `--no-color` flag).
 */
export function renderEvent(event: RunEvent, opts: RenderOptions = {}): string {
  const color = opts.color ?? false;
  switch (event.type) {
    case 'message':
      return renderMessage(event, color);
    case 'tool_call':
      return renderToolCall(event, color);
    case 'tool_result':
      return renderToolResult(event, color);
    case 'approval_requested':
      return renderApprovalRequested(event, color);
    case 'error':
      return renderError(event, color);
    case 'done':
      return renderDone(event, color);
    default: {
      // Exhaustiveness guard — every RunEvent variant must be handled above.
      const _exhaustive: never = event;
      throw new Error(`renderEvent: unknown event variant ${String(_exhaustive)}`);
    }
  }
}

/**
 * Render a `RunEvent` as a single JSON Lines record. Pure passthrough — no
 * transformation beyond `JSON.stringify`. The CLI command appends `\n` itself.
 */
export function renderJsonLine(event: RunEvent): string {
  return JSON.stringify(event);
}
