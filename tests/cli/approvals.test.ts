import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { createTtyApprovalResolver } from '../../src/cli/approvals.js';
import type { ApprovalContext } from '../../src/core/tools/interceptor.js';

function makeStreams(opts: { inputIsTTY: boolean }): {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  written: string[];
} {
  const written: string[] = [];
  const input = new PassThrough() as unknown as NodeJS.ReadStream;
  Object.defineProperty(input, 'isTTY', { value: opts.inputIsTTY, configurable: true });
  const output = new PassThrough() as unknown as NodeJS.WriteStream;
  (output as unknown as { columns: number }).columns = 80;
  output.on('data', (chunk: Buffer | string) => {
    written.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  });
  return { input, output, written };
}

function makeCtx(): ApprovalContext {
  return {
    toolCallId: 'tc_1',
    tool: 'fs.write',
    args: { path: '/x' },
    decision: {
      outcome: 'approval_required',
      risk: 'write',
      reason: 'write requires approval',
      rule: 'risk_levels',
    },
  };
}

describe('createTtyApprovalResolver — non-interactive', () => {
  it('defaults to reject when stdin is not a TTY', async () => {
    const { input, output, written } = makeStreams({ inputIsTTY: false });
    const resolver = createTtyApprovalResolver({ input, output });
    const verdict = await resolver(makeCtx());
    expect(verdict).toBe('reject');
    expect(written.join('')).toContain('auto-rejecting');
  });

  it('honours nonInteractive: approve in non-TTY mode', async () => {
    const { input, output, written } = makeStreams({ inputIsTTY: false });
    const resolver = createTtyApprovalResolver({
      input,
      output,
      nonInteractive: 'approve',
    });
    const verdict = await resolver(makeCtx());
    expect(verdict).toBe('approve');
    expect(written.join('')).toContain('auto-approving');
  });
});

describe('createTtyApprovalResolver — interactive', () => {
  it('approves on "y" input', async () => {
    const { input, output } = makeStreams({ inputIsTTY: true });
    const resolver = createTtyApprovalResolver({ input, output, timeoutMs: 5000 });
    const promise = resolver(makeCtx());
    // Write the answer after a tick so the readline interface is wired up.
    setImmediate(() => (input as unknown as PassThrough).write('y\n'));
    const verdict = await promise;
    expect(verdict).toBe('approve');
  });

  it('rejects on "n" input', async () => {
    const { input, output } = makeStreams({ inputIsTTY: true });
    const resolver = createTtyApprovalResolver({ input, output, timeoutMs: 5000 });
    const promise = resolver(makeCtx());
    setImmediate(() => (input as unknown as PassThrough).write('n\n'));
    const verdict = await promise;
    expect(verdict).toBe('reject');
  });

  it('rejects on empty input (default N)', async () => {
    const { input, output } = makeStreams({ inputIsTTY: true });
    const resolver = createTtyApprovalResolver({ input, output, timeoutMs: 5000 });
    const promise = resolver(makeCtx());
    setImmediate(() => (input as unknown as PassThrough).write('\n'));
    const verdict = await promise;
    expect(verdict).toBe('reject');
  });

  it('rejects on timeout', async () => {
    const { input, output, written } = makeStreams({ inputIsTTY: true });
    const resolver = createTtyApprovalResolver({ input, output, timeoutMs: 20 });
    const verdict = await resolver(makeCtx());
    expect(verdict).toBe('reject');
    expect(written.join('')).toContain('timeout');
  });
});
