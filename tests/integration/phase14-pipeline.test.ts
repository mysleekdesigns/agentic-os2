/**
 * Phase 14 — Consolidated integration tests (PRD §14, Bundle B).
 *
 * Exercises the full pipeline using the in-process `FakeProvider`
 * (`src/core/providers/fake.ts`) and `createFakeProviderAdapter`
 * (`tests/core/tasks/_fake-provider-adapter.ts`). The intent is one
 * confidence-building suite that wires together: tool policy, the
 * approval queue, durable resume after crash, executor retry, the
 * pure memory policy, and the deterministic half of the eval scorer.
 *
 * No LLM is ever called. Anything that would require a real model
 * (e.g. an `llm-rubric` assertion) is deliberately skipped — see the
 * `// note:` comments inside each `it` block.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

import type { SecurityConfig } from '../../src/config/schema.js';
import type { AgentFrontmatter } from '../../src/core/agents/schema.js';
import {
  FakeProvider,
  scriptedTranscript,
  type AgentRunInput,
  type RunEvent,
} from '../../src/core/providers/index.js';
import {
  interceptProviderStream,
  type ApprovalResolver,
  type ToolAuditor,
} from '../../src/core/tools/interceptor.js';
import {
  resumeWorkflow,
  runWorkflow,
  type WorkflowDef,
  type WorkflowEvent,
} from '../../src/core/tasks/index.js';
import { decideRequest, listRequests } from '../../src/core/approvals/index.js';
import { enforceMemoryAccess } from '../../src/core/memory/policy.js';
import { runFixture, type RunAgentFn } from '../../src/core/eval/runner.js';
import { openDatabase, type AgentOsDb } from '../../src/storage/db.js';
import { runMigrations } from '../../src/storage/migrate.js';
import { createBlobStore, type BlobStore } from '../../src/storage/blobs.js';
import { agents, approvals, runs } from '../../src/storage/schema.js';
import { createFakeProviderAdapter } from '../core/tasks/_fake-provider-adapter.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface DbHarness {
  rootDir: string;
  dbPath: string;
  db: AgentOsDb;
  blobs: BlobStore;
}

async function makeHarness(): Promise<DbHarness> {
  const rootDir = await mkdtemp(join(tmpdir(), 'agent-os-p14-int-'));
  const dbPath = join(rootDir, 'agent-os.sqlite');
  const db = openDatabase(dbPath);
  await runMigrations(db, { log: () => undefined });
  const blobs = createBlobStore({ root: join(rootDir, 'blobs') });
  for (const id of ['lead', 'worker_a', 'flaky']) {
    await db.insert(agents).values({
      id,
      version: '1',
      definitionPath: `agents/${id}.md`,
      hash: 'cafebabe',
      createdAt: new Date(),
    });
  }
  return { rootDir, dbPath, db, blobs };
}

async function tearDown(h: DbHarness): Promise<void> {
  try {
    h.db.$sqlite.close();
  } catch {
    /* already closed */
  }
  await rm(h.rootDir, { recursive: true, force: true });
}

async function collectRunEvents(stream: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

async function collectWorkflowEvents(
  stream: AsyncIterable<WorkflowEvent>,
): Promise<WorkflowEvent[]> {
  const out: WorkflowEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

type AgentForPolicy = Pick<AgentFrontmatter, 'id' | 'tools' | 'permissions'>;

function makePolicyAgent(overrides: Partial<AgentForPolicy['tools']> = {}): AgentForPolicy {
  return {
    id: 'tester',
    tools: {
      allowed: overrides.allowed ?? ['fs.read'],
      approval_required: overrides.approval_required ?? ['Bash'],
    },
    permissions: {
      network: 'approval_required',
      file_read: 'allow',
      file_write: 'approval_required',
      shell: 'approval_required',
    },
  };
}

function makeSecurity(overrides: Partial<SecurityConfig> = {}): SecurityConfig {
  return {
    default_tool_policy: 'deny',
    risk_levels: {
      read: 'allow',
      write: 'approval_required',
      network: 'approval_required',
      shell: 'approval_required',
      destructive: 'deny',
    },
    pinned_mcp_servers: true,
    redact_secrets_in_logs: true,
    ...overrides,
  };
}

function makeRunInput(): AgentRunInput {
  return {
    agentId: 'tester',
    goal: 'goal',
    instructions: '',
    workspaceRoot: '/tmp/x',
  };
}

interface AuditSink {
  calls: Array<{
    toolCallId: string;
    tool: string;
    decision: string;
    rule: string;
    risk: string;
    decidedBy?: string;
  }>;
  results: Array<{ toolCallId: string; isError?: boolean }>;
}

function makeAuditor(): { auditor: ToolAuditor; sink: AuditSink } {
  const sink: AuditSink = { calls: [], results: [] };
  const auditor: ToolAuditor = {
    onCall(r) {
      sink.calls.push({
        toolCallId: r.toolCallId,
        tool: r.tool,
        decision: r.decision,
        rule: r.rule,
        risk: r.risk,
        ...(r.decidedBy !== undefined ? { decidedBy: r.decidedBy } : {}),
      });
    },
    onResult(r) {
      sink.results.push({
        toolCallId: r.toolCallId,
        ...(r.isError !== undefined ? { isError: r.isError } : {}),
      });
    },
  };
  return { auditor, sink };
}

// ---------------------------------------------------------------------------
// (a) Tool denial pipeline
// ---------------------------------------------------------------------------

describe('Phase 14 integration — tool denial', () => {
  it('a destructive tool_call is denied; the agent sees only a synthetic error result and audit logs decision=deny rule=risk_levels', async () => {
    const events = scriptedTranscript()
      .toolCall('fs.rm', { path: '/etc' })
      .toolResult('the provider tried anyway')
      .done({ reason: 'completed' })
      .build();
    const provider = new FakeProvider({ events });
    const { auditor, sink } = makeAuditor();

    const out = await collectRunEvents(
      interceptProviderStream(provider, makeRunInput(), {
        agent: makePolicyAgent(),
        security: makeSecurity(),
        auditor,
      }),
    );

    // Provider's real `tool_call` MUST NOT be passed through.
    expect(out.some((e) => e.type === 'tool_call')).toBe(false);

    // Synthetic deny-style result is the only `tool_result` the agent sees.
    const results = out.filter(
      (e): e is Extract<RunEvent, { type: 'tool_result' }> => e.type === 'tool_result',
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.isError).toBe(true);

    // Audit row: destructive risk routed through the risk_levels rule => deny.
    expect(sink.calls[0]).toMatchObject({
      tool: 'fs.rm',
      decision: 'deny',
      rule: 'risk_levels',
      decidedBy: 'policy',
    });
  });
});

// ---------------------------------------------------------------------------
// (b) Approval flow (inline) — approve and reject in a single test
// ---------------------------------------------------------------------------

describe('Phase 14 integration — inline approval flow', () => {
  it('approve lets the call through; reject surfaces a synthetic error result', async () => {
    // ---- approve --------------------------------------------------------
    {
      const events = scriptedTranscript()
        .toolCall('Bash', { cmd: 'echo hi' })
        .toolResult('hi\n')
        .done({ reason: 'completed' })
        .build();
      const provider = new FakeProvider({ events });
      const resolver: ApprovalResolver = vi.fn(async () => 'approve');
      const { auditor, sink } = makeAuditor();

      const out = await collectRunEvents(
        interceptProviderStream(provider, makeRunInput(), {
          agent: makePolicyAgent(),
          security: makeSecurity(),
          approvalResolver: resolver,
          auditor,
        }),
      );

      expect(out.filter((e) => e.type === 'approval_requested')).toHaveLength(1);
      expect(out.filter((e) => e.type === 'tool_call')).toHaveLength(1);
      const results = out.filter(
        (e): e is Extract<RunEvent, { type: 'tool_result' }> => e.type === 'tool_result',
      );
      expect(results).toHaveLength(1);
      expect(results[0]?.isError).toBeUndefined();
      expect(resolver).toHaveBeenCalledTimes(1);
      expect(sink.calls[0]).toMatchObject({
        tool: 'Bash',
        decision: 'approval_required',
        decidedBy: 'human',
      });
    }

    // ---- reject ---------------------------------------------------------
    {
      const events = scriptedTranscript()
        .toolCall('Bash', { cmd: 'rm -rf /' })
        .toolResult('should not be seen')
        .done({ reason: 'completed' })
        .build();
      const provider = new FakeProvider({ events });
      const resolver: ApprovalResolver = vi.fn(async () => 'reject');
      const { auditor, sink } = makeAuditor();

      const out = await collectRunEvents(
        interceptProviderStream(provider, makeRunInput(), {
          agent: makePolicyAgent(),
          security: makeSecurity(),
          approvalResolver: resolver,
          auditor,
        }),
      );

      // The real `tool_call` MUST be suppressed.
      expect(out.some((e) => e.type === 'tool_call')).toBe(false);
      const results = out.filter(
        (e): e is Extract<RunEvent, { type: 'tool_result' }> => e.type === 'tool_result',
      );
      expect(results).toHaveLength(1);
      expect(results[0]?.isError).toBe(true);
      expect(sink.calls[0]).toMatchObject({
        tool: 'Bash',
        decision: 'approval_required',
      });
      // No `decidedBy` recorded when a human rejects (per PRD §2.5).
      expect(sink.calls[0]?.decidedBy).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// (c) Approval flow (queue) + resume after a simulated crash
// ---------------------------------------------------------------------------

describe('Phase 14 integration — queue approval + crash-resume', () => {
  let h: DbHarness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => tearDown(h));

  it('persists an approval row, survives a simulated crash, and completes after decideRequest(approve)', async () => {
    // 1) First run: workflow pauses at the approval gate.
    const def: WorkflowDef = {
      id: 'wf-queue-crash',
      version: 1,
      steps: [
        { kind: 'approval', id: 'gate', prompt: 'ship?', risk: 'write' },
        { kind: 'agent', id: 'after', agent: 'worker_a', goal: 'post-approval' },
      ],
    };
    const runId = 'r-queue-crash';

    const adapter1 = createFakeProviderAdapter();
    const evs1 = await collectWorkflowEvents(
      runWorkflow({
        def,
        runId,
        agentId: 'lead',
        db: h.db,
        blobs: h.blobs,
        providerAdapter: adapter1,
        approvalResolver: async () => 'pending',
      }),
    );
    expect(evs1.some((e) => e.type === 'workflow_paused')).toBe(true);
    expect(evs1.some((e) => e.type === 'approval_requested')).toBe(true);

    const approvalRow = (await h.db.select().from(approvals))[0]!;
    expect(approvalRow.status).toBe('pending');

    // 2) Simulate a crash: drop the DB connection without finalising.
    h.db.$sqlite.close();

    // 3) Reopen the DB on a fresh connection (the on-disk SQLite file is the
    //    durable substrate). Tooling and adapter are recreated as well, as a
    //    real operator-driven resume would.
    const reopened = openDatabase(h.dbPath);
    h.db = reopened; // ensure teardown can close it

    // The approval row still exists and is still pending.
    const stillPending = await reopened
      .select()
      .from(approvals)
      .where(eq(approvals.id, approvalRow.id));
    expect(stillPending[0]?.status).toBe('pending');

    // Out-of-band: a reviewer approves.
    await decideRequest({
      db: reopened,
      approvalId: approvalRow.id,
      verdict: 'approve',
      decidedBy: 'tester',
    });

    // Sanity-check that the listing reflects the decision.
    const listed = await listRequests({ db: reopened, includeExpired: true });
    expect(listed.find((r) => r.id === approvalRow.id)?.status).toBe('approved');

    // 4) Resume on the fresh connection.
    const adapter2 = createFakeProviderAdapter();
    const blobs2 = createBlobStore({ root: join(h.rootDir, 'blobs') });
    const evs2 = await collectWorkflowEvents(
      resumeWorkflow({
        def,
        runId,
        db: reopened,
        blobs: blobs2,
        providerAdapter: adapter2,
      }),
    );
    expect(evs2.some((e) => e.type === 'workflow_completed')).toBe(true);

    const finalRun = await reopened.select().from(runs).where(eq(runs.id, runId));
    expect(finalRun[0]?.status).toBe('succeeded');
    // The post-approval step ran exactly once on the resumed run.
    expect(adapter2.callsFor('after')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// (d) Retry on transient error
// ---------------------------------------------------------------------------

describe('Phase 14 integration — retry on transient error', () => {
  let h: DbHarness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => tearDown(h));

  it("retries per the step's RetryPolicy and succeeds once the adapter stops throwing", async () => {
    // The executor's retry semantics live in `src/core/tasks/executor.ts`
    // (see `RetryPolicy` and the `while (attempt < retry.max_attempts)`
    // loop). We exercise the documented path: first attempt throws, second
    // attempt succeeds, the step lands as `succeeded`.
    const def: WorkflowDef = {
      id: 'wf-retry-int',
      version: 1,
      steps: [
        {
          kind: 'agent',
          id: 'flaky',
          agent: 'flaky',
          goal: 'try',
          retry: { max_attempts: 2, backoff_ms: 1 },
        },
      ],
    };
    const adapter = createFakeProviderAdapter({
      scripts: {
        flaky: {
          outcomes: [
            { kind: 'throw', error: 'transient' },
            { kind: 'ok', output: 'recovered' },
          ],
        },
      },
    });

    const evs = await collectWorkflowEvents(
      runWorkflow({
        def,
        runId: 'r-retry-int',
        agentId: 'lead',
        db: h.db,
        blobs: h.blobs,
        providerAdapter: adapter,
      }),
    );

    expect(evs.some((e) => e.type === 'workflow_completed')).toBe(true);
    expect(evs.some((e) => e.type === 'step_retrying')).toBe(true);
    expect(adapter.callsFor('flaky')).toHaveLength(2);
  });

  it('when retries are exhausted, the run lands `failed` and is operator-resumable from the DB record', async () => {
    // note: the executor does NOT silently retry past `max_attempts`.
    // We assert the documented escalation: error recorded, run failed.
    const def: WorkflowDef = {
      id: 'wf-retry-exhaust',
      version: 1,
      steps: [
        {
          kind: 'agent',
          id: 'flaky',
          agent: 'flaky',
          goal: 'try',
          retry: { max_attempts: 1, backoff_ms: 0 },
        },
      ],
    };
    const adapter = createFakeProviderAdapter({
      scripts: {
        flaky: { outcomes: [{ kind: 'throw', error: 'fatal' }] },
      },
    });

    await collectWorkflowEvents(
      runWorkflow({
        def,
        runId: 'r-retry-exhaust',
        agentId: 'lead',
        db: h.db,
        blobs: h.blobs,
        providerAdapter: adapter,
      }),
    );

    const row = await h.db.select().from(runs).where(eq(runs.id, 'r-retry-exhaust'));
    expect(row[0]?.status).toBe('failed');
    // The error is persisted on the run row for an operator-driven retry.
    expect(row[0]?.summary ?? '').toMatch(/fatal/);
  });
});

// ---------------------------------------------------------------------------
// (e) Memory scope enforcement
// ---------------------------------------------------------------------------

describe('Phase 14 integration — memory scope policy', () => {
  it('denies a read against a scope not in agent.memory.read and emits memory.denied', async () => {
    const agent: AgentFrontmatter = {
      id: 'note_taker',
      name: 'Note taker',
      version: 1,
      role: 'notes',
      provider: 'claude_code_local',
      tools: { allowed: [], approval_required: [] },
      permissions: {
        network: 'deny',
        file_read: 'allow',
        file_write: 'approval_required',
        shell: 'deny',
      },
      memory: { read: ['project'], write: ['project'] },
    };

    const logged: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    const decision = enforceMemoryAccess({
      agent,
      action: 'read',
      scope: 'user_preferences',
      eventLogger: {
        emit({ kind, payload }) {
          logged.push({ kind, payload });
        },
      },
    });

    expect(decision.outcome).toBe('deny');
    expect(decision.scope).toBe('user_preferences');
    expect(decision.action).toBe('read');
    expect(logged).toHaveLength(1);
    expect(logged[0]?.kind).toBe('memory.denied');
    expect(logged[0]?.payload).toMatchObject({
      agent_id: 'note_taker',
      action: 'read',
      scope: 'user_preferences',
    });
  });

  it('allows a write to a scope that is in agent.memory.write', async () => {
    const agent: AgentFrontmatter = {
      id: 'note_taker',
      name: 'Note taker',
      version: 1,
      role: 'notes',
      provider: 'claude_code_local',
      tools: { allowed: [], approval_required: [] },
      permissions: {
        network: 'deny',
        file_read: 'allow',
        file_write: 'approval_required',
        shell: 'deny',
      },
      memory: { read: ['project'], write: ['project'] },
    };

    const decision = enforceMemoryAccess({
      agent,
      action: 'write',
      scope: 'project',
    });
    expect(decision.outcome).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// (f) Eval scoring — deterministic path only
// ---------------------------------------------------------------------------

describe('Phase 14 integration — eval scoring', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-os-p14-eval-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // note: we intentionally do NOT exercise `llm-rubric` here. Without a
  // grader the runner records it as `skipped: true` (which still counts
  // toward score), and we never call a real LLM in tests.
  const FIXTURE_YAML = `description: 'phase14 smoke'
prompts:
  - 'hi'
providers:
  - id: agent-os:demo_agent
tests:
  - description: 'must say hello and include a number'
    assert:
      - type: icontains
        value: 'HELLO'
      - type: regex
        value: '\\d+'
`;

  it('scores pass=true when the hand-crafted transcript satisfies every deterministic assertion', async () => {
    const file = join(dir, 'fixture.yaml');
    await writeFile(file, FIXTURE_YAML, 'utf8');
    const runAgent: RunAgentFn = async () => 'Hello world 42';

    const result = await runFixture(file, { runAgent });
    expect(result.passed).toBe(true);
    for (const c of result.cases) {
      expect(c.passed).toBe(true);
      expect(c.assertions.every((a) => a.passed)).toBe(true);
    }
  });

  it('scores pass=false when the transcript misses an assertion', async () => {
    const file = join(dir, 'fixture-fail.yaml');
    await writeFile(file, FIXTURE_YAML, 'utf8');
    // Missing the digit; "hello" still present.
    const runAgent: RunAgentFn = async () => 'Hello, no number here';

    const result = await runFixture(file, { runAgent });
    expect(result.passed).toBe(false);
    for (const c of result.cases) {
      expect(c.passed).toBe(false);
      // The `icontains` HELLO assertion still passes; the regex fails.
      const regex = c.assertions.find((a) => a.type === 'regex');
      expect(regex?.passed).toBe(false);
    }
  });
});
