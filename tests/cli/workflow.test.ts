import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

import { buildProgram } from '../../src/cli/index.js';
import { runInit } from '../../src/cli/commands/init.js';
import {
  FakeProvider,
  registerProvider,
  scriptedTranscript,
  unregisterProvider,
} from '../../src/core/providers/index.js';
import { openDatabase } from '../../src/storage/db.js';
import { runMigrations } from '../../src/storage/migrate.js';
import { approvals, runs } from '../../src/storage/schema.js';

/** Minimal one-step agent workflow. */
const SIMPLE_WORKFLOW = `id: hello
version: 1
description: A trivial one-step workflow.
steps:
  - kind: agent
    id: greet
    agent: greeter
    goal: say hello to \${inputs.name}
`;

/** Two-step workflow whose second step is an approval gate. */
const PAUSED_WORKFLOW = `id: pause-me
version: 1
description: Pauses on the approval step.
steps:
  - kind: agent
    id: prep
    agent: greeter
    goal: get ready
  - kind: approval
    id: gate
    prompt: ok to proceed?
    risk: write
`;

async function runCli(argv: readonly string[]): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
}> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  let exitCode: number | null = null;

  const writeStdout = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    });
  const writeStderr = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    });
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`__exit_${exitCode}__`);
  }) as (code?: number) => never);

  const program = buildProgram();
  program.exitOverride();

  try {
    await program.parseAsync(['node', 'agent-os', ...argv]);
  } catch (err) {
    void err;
  } finally {
    writeStdout.mockRestore();
    writeStderr.mockRestore();
    exit.mockRestore();
  }

  return { stdout: stdoutChunks.join(''), stderr: stderrChunks.join(''), exitCode };
}

describe('agent-os workflow', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agent-os-workflow-'));
    runInit({ cwd: tmpDir });
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
    unregisterProvider('claude_code_local');
  });

  it('list prints a friendly message when no workflows are present', async () => {
    const { stdout, exitCode } = await runCli(['workflow', 'list']);
    expect(exitCode).toBeNull();
    expect(stdout).toMatch(/No workflows found/);
  });

  it('list --json returns an array containing the workflow', async () => {
    writeFileSync(join(tmpDir, 'workflows', 'hello.yaml'), SIMPLE_WORKFLOW);
    const { stdout, exitCode } = await runCli(['workflow', 'list', '--json']);
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout) as Array<{ id: string; version: number; path: string }>;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.id).toBe('hello');
    expect(parsed[0]!.version).toBe(1);
  });

  it('list also includes workflows from workflows/examples/', async () => {
    writeFileSync(join(tmpDir, 'workflows', 'examples', 'sample.yaml'), SIMPLE_WORKFLOW);
    const { stdout, exitCode } = await runCli(['workflow', 'list', '--json']);
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout) as Array<{ id: string }>;
    expect(parsed.map((p) => p.id)).toContain('hello');
  });

  it('run executes a workflow against the registered provider and exits 0', async () => {
    writeFileSync(join(tmpDir, 'workflows', 'hello.yaml'), SIMPLE_WORKFLOW);

    const events = scriptedTranscript()
      .message('assistant', 'hi simon')
      .done({ reason: 'completed', durationMs: 1 })
      .build();
    registerProvider('claude_code_local', () => new FakeProvider({ events }));

    const { stdout, exitCode } = await runCli([
      'workflow',
      'run',
      'hello',
      '--input',
      'name=simon',
      '--json',
    ]);

    expect(exitCode === null || exitCode === 0).toBe(true);
    expect(stdout).toMatch(/^run_id: /m);
    const eventLines = stdout
      .split('\n')
      .filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l) as { type: string; output?: unknown });
    expect(eventLines.some((e) => e.type === 'step_started')).toBe(true);
    const completed = eventLines.find((e) => e.type === 'step_completed');
    expect(completed).toBeDefined();
    expect(completed!.output).toBe('hi simon');
    expect(eventLines.some((e) => e.type === 'workflow_completed')).toBe(true);
  });

  it('run exits 1 when the workflow id is unknown', async () => {
    const { stderr, exitCode } = await runCli(['workflow', 'run', 'no-such']);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/workflow "no-such" not found/);
  });

  it('run exits 1 and tells the user how to resume when the workflow pauses on approval', async () => {
    writeFileSync(join(tmpDir, 'workflows', 'pause.yaml'), PAUSED_WORKFLOW);

    const events = scriptedTranscript()
      .message('assistant', 'ready')
      .done({ reason: 'completed', durationMs: 1 })
      .build();
    registerProvider('claude_code_local', () => new FakeProvider({ events }));

    const { stdout, stderr, exitCode } = await runCli(['workflow', 'run', 'pause-me']);
    expect(exitCode).toBe(1);
    expect(stdout).toMatch(/workflow paused at gate/);
    expect(stderr).toMatch(/resume with `agent-os workflow resume /);
  });

  it('show prints the run row and steps after a completed run', async () => {
    writeFileSync(join(tmpDir, 'workflows', 'hello.yaml'), SIMPLE_WORKFLOW);
    const events = scriptedTranscript()
      .message('assistant', 'hi')
      .done({ reason: 'completed', durationMs: 1 })
      .build();
    registerProvider('claude_code_local', () => new FakeProvider({ events }));

    const runRes = await runCli(['workflow', 'run', 'hello', '--input', 'name=x', '--json']);
    const match = /^run_id: (\S+)/m.exec(runRes.stdout);
    expect(match).not.toBeNull();
    const runId = match![1]!;

    const { stdout, exitCode } = await runCli(['workflow', 'show', runId, '--json']);
    expect(exitCode === null || exitCode === 0).toBe(true);
    const payload = JSON.parse(stdout) as {
      run: { id: string; status: string; workflow_id: string };
      steps: Array<{ id: string; status: string }>;
      pending_approvals: unknown[];
    };
    expect(payload.run.id).toBe(runId);
    expect(payload.run.workflow_id).toBe('hello');
    expect(payload.run.status).toBe('succeeded');
    expect(payload.steps.length).toBeGreaterThan(0);
    expect(payload.pending_approvals).toEqual([]);
  });

  it('cancel marks a paused run as cancelled', async () => {
    writeFileSync(join(tmpDir, 'workflows', 'pause.yaml'), PAUSED_WORKFLOW);
    const events = scriptedTranscript()
      .message('assistant', 'ready')
      .done({ reason: 'completed', durationMs: 1 })
      .build();
    registerProvider('claude_code_local', () => new FakeProvider({ events }));

    const runRes = await runCli(['workflow', 'run', 'pause-me']);
    const match = /^run_id: (\S+)/m.exec(runRes.stdout);
    expect(match).not.toBeNull();
    const runId = match![1]!;

    const cancelRes = await runCli(['workflow', 'cancel', runId]);
    expect(cancelRes.exitCode === null || cancelRes.exitCode === 0).toBe(true);
    expect(cancelRes.stdout).toContain(`cancelled: ${runId}`);

    const showRes = await runCli(['workflow', 'show', runId, '--json']);
    const payload = JSON.parse(showRes.stdout) as { run: { status: string } };
    expect(payload.run.status).toBe('cancelled');
  });

  it('cancel exits 1 when the run id is unknown', async () => {
    const { stderr, exitCode } = await runCli([
      'workflow',
      'cancel',
      '00000000-0000-0000-0000-000000000000',
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/not found/);
  });

  it('resume completes the workflow after the approval row is flipped to approved', async () => {
    writeFileSync(join(tmpDir, 'workflows', 'pause.yaml'), PAUSED_WORKFLOW);
    const events = scriptedTranscript()
      .message('assistant', 'ready')
      .done({ reason: 'completed', durationMs: 1 })
      .build();
    registerProvider('claude_code_local', () => new FakeProvider({ events }));

    // First run — pauses on the approval gate.
    const firstRun = await runCli(['workflow', 'run', 'pause-me']);
    expect(firstRun.exitCode).toBe(1);
    const match = /run_id:\s*(\S+)/.exec(firstRun.stdout);
    expect(match).not.toBeNull();
    const runId = match![1]!;

    // Flip the approval to approved.
    const db = openDatabase(join(tmpDir, '.agent-os', 'db.sqlite'));
    try {
      await runMigrations(db, { log: () => undefined });
      const pending = await db.select().from(approvals).where(eq(approvals.runId, runId));
      expect(pending).toHaveLength(1);
      await db
        .update(approvals)
        .set({ status: 'approved', decidedBy: 'test', decidedAt: new Date() })
        .where(eq(approvals.id, pending[0]!.id));
    } finally {
      db.$sqlite.close();
    }

    // Re-register the provider for the resume invocation (afterEach
    // unregisters, but the previous runCli call left it registered; this
    // re-register is defensive against future reordering).
    const resumeEvents = scriptedTranscript()
      .message('assistant', 'ok')
      .done({ reason: 'completed', durationMs: 1 })
      .build();
    registerProvider('claude_code_local', () => new FakeProvider({ events: resumeEvents }));

    const resumeRes = await runCli(['workflow', 'resume', runId]);
    expect(resumeRes.exitCode === null || resumeRes.exitCode === 0).toBe(true);

    // Confirm the run is now succeeded on disk.
    const db2 = openDatabase(join(tmpDir, '.agent-os', 'db.sqlite'));
    try {
      await runMigrations(db2, { log: () => undefined });
      const rows = await db2.select().from(runs).where(eq(runs.id, runId));
      expect(rows[0]?.status).toBe('succeeded');
    } finally {
      db2.$sqlite.close();
    }
  });

  it('runs successfully with ANTHROPIC_API_KEY and OPENAI_API_KEY unset (PRD §4)', async () => {
    const savedAnthropic = process.env.ANTHROPIC_API_KEY;
    const savedOpenai = process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      writeFileSync(join(tmpDir, 'workflows', 'hello.yaml'), SIMPLE_WORKFLOW);
      const events = scriptedTranscript()
        .message('assistant', 'hi')
        .done({ reason: 'completed', durationMs: 1 })
        .build();
      registerProvider('claude_code_local', () => new FakeProvider({ events }));

      const { exitCode } = await runCli([
        'workflow',
        'run',
        'hello',
        '--input',
        'name=tester',
        '--json',
      ]);
      expect(exitCode === null || exitCode === 0).toBe(true);
    } finally {
      if (savedAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = savedAnthropic;
      if (savedOpenai !== undefined) process.env.OPENAI_API_KEY = savedOpenai;
    }
  });
});

describe('buildWorkflowCommand wiring', () => {
  it('exposes list/run/resume/cancel/show subcommands under the `workflow` group', () => {
    const program = buildProgram();
    const wf = program.commands.find((c) => c.name() === 'workflow');
    expect(wf).toBeDefined();
    const subs = wf!.commands.map((c) => c.name());
    expect(subs).toContain('list');
    expect(subs).toContain('run');
    expect(subs).toContain('resume');
    expect(subs).toContain('cancel');
    expect(subs).toContain('show');
  });
});
