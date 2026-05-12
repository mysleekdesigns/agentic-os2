/**
 * TTY approval resolver for the policy interceptor (PRD §2.5, Phase 4).
 *
 * Reads a single line of input from stdin in interactive contexts; defaults to
 * reject (or, when explicitly configured, approve) in non-TTY contexts so CI
 * pipelines and tests never hang on a missing prompt.
 */

import { createInterface } from 'node:readline';

import type { ApprovalResolver } from '../core/tools/interceptor.js';

export interface TtyApprovalResolverOptions {
  /** Override for tests. Default: `process.stdin`. */
  input?: NodeJS.ReadStream;
  /** Override for tests. Default: `process.stdout`. */
  output?: NodeJS.WriteStream;
  /** What to do when stdin is not a TTY. Default: `'reject'`. */
  nonInteractive?: 'reject' | 'approve';
  /** Timeout in ms; on expiry the resolver rejects. Default: 60000. */
  timeoutMs?: number;
}

/**
 * Build an `ApprovalResolver` that reads y/N from stdin. In non-TTY contexts
 * (CI, tests, piped input) it short-circuits to `opts.nonInteractive` — that
 * default is `'reject'` so the system errs safe by construction.
 */
export function createTtyApprovalResolver(opts: TtyApprovalResolverOptions = {}): ApprovalResolver {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const nonInteractive = opts.nonInteractive ?? 'reject';
  const timeoutMs = opts.timeoutMs ?? 60000;

  return async (ctx) => {
    if (!input.isTTY) {
      output.write(
        `agent-os: ${nonInteractive === 'approve' ? 'auto-approving' : 'auto-rejecting'} ${
          ctx.tool
        } (${ctx.decision.risk}) in non-interactive mode\n`,
      );
      return nonInteractive;
    }

    const rl = createInterface({ input, output });
    const prompt = `agent-os: approve ${ctx.tool} (${ctx.decision.risk})? [y/N] (${ctx.decision.reason}) `;

    let timer: NodeJS.Timeout | undefined;
    try {
      return await new Promise<'approve' | 'reject'>((resolve) => {
        let settled = false;
        const finish = (verdict: 'approve' | 'reject'): void => {
          if (settled) return;
          settled = true;
          resolve(verdict);
        };

        timer = setTimeout(() => {
          output.write(`\nagent-os: approval timeout after ${timeoutMs}ms — rejecting\n`);
          finish('reject');
        }, timeoutMs);

        rl.question(prompt, (answer) => {
          const trimmed = (answer ?? '').trim().toLowerCase();
          finish(trimmed.startsWith('y') ? 'approve' : 'reject');
        });
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      rl.close();
    }
  };
}
