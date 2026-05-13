import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface SpawnCall {
  command: string;
  args: readonly string[];
  options: Record<string, unknown>;
}

const spawnCalls: SpawnCall[] = [];
const spawnSyncCalls: SpawnCall[] = [];
let nextSpawnPid: number | null = 424242;
let nextSpawnSyncStatus: number = 0;

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: vi.fn((command: string, args: readonly string[], options: Record<string, unknown>) => {
      spawnCalls.push({ command, args, options });
      return {
        pid: nextSpawnPid,
        unref: () => undefined,
        on: () => undefined,
      };
    }),
    spawnSync: vi.fn(
      (command: string, args: readonly string[], options: Record<string, unknown>) => {
        spawnSyncCalls.push({ command, args, options });
        return { status: nextSpawnSyncStatus, stdout: '', stderr: '', error: null };
      },
    ),
  };
});

// Import after the mock so the dashboard module picks up the mocked spawn.
const { buildProgram } = await import('../../src/cli/index.js');

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

async function runCli(argv: readonly string[]): Promise<CliResult> {
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
    throw new Error(`__exit_${String(exitCode)}__`);
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

  return {
    stdout: stdoutChunks.join(''),
    stderr: stderrChunks.join(''),
    exitCode,
  };
}

describe('agent-os dashboard', () => {
  let tmpDir: string;
  let originalCwd: string;
  let originalEnvToken: string | undefined;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `agent-os-dashboard-${String(process.pid)}-${String(Math.random())}`);
    mkdirSync(tmpDir, { recursive: true });
    originalCwd = process.cwd();
    process.chdir(tmpDir);

    // Pre-create web/.next so the prod path skips `next build`. The actual web
    // workspace lives next to the repo root; we also stub the in-cwd path so
    // resolveWebWorkspace's existsSync passes regardless.
    spawnCalls.length = 0;
    spawnSyncCalls.length = 0;
    nextSpawnPid = 424242;
    nextSpawnSyncStatus = 0;

    originalEnvToken = process.env.AGENT_OS_DASHBOARD_TOKEN;
    delete process.env.AGENT_OS_DASHBOARD_TOKEN;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
    if (originalEnvToken === undefined) {
      delete process.env.AGENT_OS_DASHBOARD_TOKEN;
    } else {
      process.env.AGENT_OS_DASHBOARD_TOKEN = originalEnvToken;
    }
  });

  describe('start', () => {
    it('spawns next with default 127.0.0.1:3030 and writes the pidfile', async () => {
      // Ensure the prod path doesn't try to run `next build` — pre-create .next
      // in the real web workspace dir. The dashboard resolves its workspace
      // relative to the compiled module: dist/cli/commands → repo/web.
      // Under vitest (tsx), src/cli/commands → repo/web — same path.
      const webDir = resolve(__dirname, '..', '..', 'web');
      mkdirSync(join(webDir, '.next'), { recursive: true });

      const { stdout, exitCode } = await runCli(['dashboard', 'start']);

      expect(exitCode).toBeNull(); // No process.exit on success path.
      expect(spawnCalls).toHaveLength(1);
      const call = spawnCalls[0]!;
      expect(call.command).toBe('npx');
      expect(call.args).toEqual(['next', 'start', '-p', '3030', '-H', '127.0.0.1']);
      expect(call.options.detached).toBe(true);
      expect(stdout).toContain('dashboard started: http://127.0.0.1:3030');
      expect(stdout).toContain('pid 424242');

      const pidPath = join(tmpDir, '.agent-os', 'dashboard.pid');
      expect(existsSync(pidPath)).toBe(true);
      expect(readFileSync(pidPath, 'utf8').trim()).toBe('424242');
    });

    it('refuses non-loopback host without AGENT_OS_DASHBOARD_TOKEN', async () => {
      const { stderr, exitCode } = await runCli(['dashboard', 'start', '--host', '0.0.0.0']);

      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/AGENT_OS_DASHBOARD_TOKEN/);
      expect(spawnCalls).toHaveLength(0);
      const pidPath = join(tmpDir, '.agent-os', 'dashboard.pid');
      expect(existsSync(pidPath)).toBe(false);
    });

    it('starts on non-loopback host when token is set', async () => {
      process.env.AGENT_OS_DASHBOARD_TOKEN = 'foo';
      const webDir = resolve(__dirname, '..', '..', 'web');
      mkdirSync(join(webDir, '.next'), { recursive: true });

      const { stdout, exitCode } = await runCli(['dashboard', 'start', '--host', '0.0.0.0']);

      expect(exitCode).toBeNull();
      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0]!.args).toEqual(['next', 'start', '-p', '3030', '-H', '0.0.0.0']);
      expect(stdout).toContain('dashboard started: http://0.0.0.0:3030');

      const pidPath = join(tmpDir, '.agent-os', 'dashboard.pid');
      expect(existsSync(pidPath)).toBe(true);
    });
  });

  describe('stop', () => {
    it('is idempotent when no pidfile exists', async () => {
      const { stderr, exitCode } = await runCli(['dashboard', 'stop']);

      // No exit() called on the success path → exitCode is null.
      expect(exitCode).toBeNull();
      expect(stderr).toContain('no dashboard running (no pidfile)');
    });

    it('removes a stale pidfile when the pid is gone', async () => {
      const pidPath = join(tmpDir, '.agent-os', 'dashboard.pid');
      mkdirSync(join(tmpDir, '.agent-os'), { recursive: true });
      writeFileSync(pidPath, '999999\n', 'utf8');

      // Force process.kill(pid, 0) to throw so the stale-pid branch fires.
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(((
        pid: number,
        signal?: string | number,
      ) => {
        if (signal === 0) {
          throw new Error('ESRCH');
        }
        return true;
      }) as typeof process.kill);

      try {
        const { stderr, exitCode } = await runCli(['dashboard', 'stop']);
        expect(exitCode).toBeNull();
        expect(stderr).toContain('stale pidfile removed');
        expect(existsSync(pidPath)).toBe(false);
      } finally {
        killSpy.mockRestore();
      }
    });

    it('sends SIGTERM and removes the pidfile when the pid is alive', async () => {
      const pidPath = join(tmpDir, '.agent-os', 'dashboard.pid');
      mkdirSync(join(tmpDir, '.agent-os'), { recursive: true });
      writeFileSync(pidPath, '12345\n', 'utf8');

      const killSpy = vi
        .spyOn(process, 'kill')
        .mockImplementation(
          ((_pid: number, _signal?: string | number) => true) as typeof process.kill,
        );

      try {
        const { stdout, exitCode } = await runCli(['dashboard', 'stop']);
        expect(exitCode).toBeNull();
        expect(stdout).toContain('dashboard stopped (pid 12345)');
        expect(existsSync(pidPath)).toBe(false);

        // First call: liveness probe (signal=0). Second: SIGTERM.
        expect(killSpy).toHaveBeenCalledWith(12345, 0);
        expect(killSpy).toHaveBeenCalledWith(12345, 'SIGTERM');
      } finally {
        killSpy.mockRestore();
      }
    });
  });
});

describe('buildDashboardCommand wiring', () => {
  it('exposes a `dashboard` command with start and stop subcommands', () => {
    const program = buildProgram();
    const dashboard = program.commands.find((c) => c.name() === 'dashboard');
    expect(dashboard).toBeDefined();
    const sub = dashboard!.commands.map((c) => c.name());
    expect(sub).toContain('start');
    expect(sub).toContain('stop');
  });
});
