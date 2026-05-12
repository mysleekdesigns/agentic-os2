/**
 * Test-only ProviderAdapter that satisfies the workflow engine's interface
 * without touching any real provider / network / env. Each step id can be
 * scripted to return a literal value, throw a sequence of errors, or hang on
 * an abort signal.
 *
 * Counters and call logs are exposed so tests can assert idempotency and
 * ordering.
 */

import type { ProviderAdapter, ProviderAdapterInput } from '../../../src/core/tasks/index.js';

export type StepScriptOutcome =
  | { kind: 'ok'; output: unknown }
  | { kind: 'throw'; error: string }
  | { kind: 'hang' }; // resolves only when the signal aborts (used for timeout tests)

export interface StepScript {
  /** Sequence of outcomes per call. After exhaustion the *last* entry repeats. */
  outcomes: StepScriptOutcome[];
}

export interface FakeProviderAdapterOptions {
  /** Keyed by `stepId`. Missing keys default to `{ kind: 'ok', output: { stepId } }`. */
  scripts?: Record<string, StepScript>;
  /** Force every call to wait this many ms before resolving (used for timeout tests). */
  artificialDelayMs?: number;
}

export interface FakeAdapterCall {
  agentId: string;
  goal: string;
  stepId: string;
  runId: string;
  attempt: number;
}

export interface FakeProviderAdapter extends ProviderAdapter {
  /** All calls made, in chronological order. */
  readonly calls: ReadonlyArray<FakeAdapterCall>;
  /** Total count of `runAgent` invocations. */
  callCount(): number;
  /** Calls scoped to a single step id. */
  callsFor(stepId: string): FakeAdapterCall[];
  /** Reset the call log (does NOT reset scripts). */
  reset(): void;
}

export function createFakeProviderAdapter(
  options: FakeProviderAdapterOptions = {},
): FakeProviderAdapter {
  const scripts = options.scripts ?? {};
  const callsByStep = new Map<string, number>();
  const calls: FakeAdapterCall[] = [];

  return {
    get calls() {
      return calls;
    },
    callCount() {
      return calls.length;
    },
    callsFor(stepId: string) {
      return calls.filter((c) => c.stepId === stepId);
    },
    reset() {
      calls.length = 0;
      callsByStep.clear();
    },
    async runAgent(input: ProviderAdapterInput): Promise<unknown> {
      const attempt = (callsByStep.get(input.stepId) ?? 0) + 1;
      callsByStep.set(input.stepId, attempt);
      calls.push({
        agentId: input.agentId,
        goal: input.goal,
        stepId: input.stepId,
        runId: input.runId,
        attempt,
      });

      if (options.artificialDelayMs !== undefined) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, options.artificialDelayMs);
          input.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new Error('aborted'));
            },
            { once: true },
          );
        });
      }

      const script = scripts[input.stepId];
      const outcome: StepScriptOutcome = script
        ? (script.outcomes[Math.min(attempt - 1, script.outcomes.length - 1)] ?? {
            kind: 'ok',
            output: { stepId: input.stepId },
          })
        : { kind: 'ok', output: { stepId: input.stepId } };

      switch (outcome.kind) {
        case 'ok':
          return outcome.output;
        case 'throw':
          throw new Error(outcome.error);
        case 'hang':
          // Wait for the abort signal; reject when it fires.
          return new Promise<unknown>((_, reject) => {
            if (input.signal.aborted) {
              reject(new Error('aborted'));
              return;
            }
            input.signal.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          });
      }
    },
  };
}
