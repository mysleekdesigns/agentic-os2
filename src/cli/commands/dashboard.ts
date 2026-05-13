/**
 * `agent-os dashboard` — optional local web UI lifecycle commands.
 *
 * PRD §3 Phase 15 exit: "Dashboard ships behind `--with-dashboard`; not
 * required for any core flow." We interpret this as: the dashboard is NEVER
 * auto-started by any other command. The two subcommands here
 * (`dashboard start` / `dashboard stop`) are the only entry points.
 *
 * Defaults bind the Next.js server to `127.0.0.1:3030` — loopback-only. If the
 * operator wants to bind to a non-loopback host they MUST set
 * `AGENT_OS_DASHBOARD_TOKEN`, which `web/middleware.ts` checks per-request.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3030;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

interface DashboardStartOptions {
  host?: string;
  port?: string;
  dev?: boolean;
}

/**
 * Locate the `web/` workspace relative to this compiled module.
 * From `dist/cli/commands/dashboard.js` → repo root is three levels up.
 * From `src/cli/commands/dashboard.ts` (when run via tsx) → same three levels.
 */
function resolveWebWorkspace(): string {
  return resolve(__dirname, '..', '..', '..', 'web');
}

/**
 * Workspace root that owns the pidfile + DB. We mirror doctor's convention:
 * `.agent-os/` next to the user's cwd. The dashboard subprocess inherits
 * `AGENT_OS_DB` so it points at the same SQLite file the CLI uses.
 */
function resolveWorkspaceRoot(): string {
  return process.cwd();
}

function pidfilePath(workspaceRoot: string): string {
  return resolve(workspaceRoot, '.agent-os', 'dashboard.pid');
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PORT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) {
    throw new Error(`invalid --port "${raw}" (expected 1..65535)`);
  }
  return n;
}

function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

/**
 * `dashboard start` implementation. Pure-ish: takes its env / cwd / spawn
 * dependencies via the harness wiring of `buildDashboardCommand`. Spawns the
 * Next.js server detached so it survives the CLI exit.
 */
function runStart(options: DashboardStartOptions): void {
  const host = options.host ?? DEFAULT_HOST;
  const port = parsePort(options.port);
  const dev = options.dev === true;

  if (!isLoopback(host)) {
    const token = process.env.AGENT_OS_DASHBOARD_TOKEN;
    if (typeof token !== 'string' || token.length === 0) {
      process.stderr.write(
        'AGENT_OS_DASHBOARD_TOKEN must be set when binding to a non-loopback host. ' +
          'Generate one with `openssl rand -hex 32`.\n',
      );
      process.exit(1);
      return;
    }
  }

  const webDir = resolveWebWorkspace();
  if (!existsSync(webDir)) {
    process.stderr.write(
      'web/ workspace not present — re-run `npm install` or check `package.json` workspaces field.\n',
    );
    process.exit(1);
    return;
  }

  // Production path: ensure the Next build exists. If `.next/` is missing we
  // run `npx next build` synchronously and surface its exit code. Skipped in
  // dev mode (Next compiles on demand).
  if (!dev) {
    const buildDir = resolve(webDir, '.next');
    if (!existsSync(buildDir)) {
      const buildResult = spawnSync('npx', ['next', 'build'], {
        cwd: webDir,
        stdio: 'inherit',
        env: process.env,
      });
      if (buildResult.status !== 0) {
        process.stderr.write(
          `next build failed (exit ${String(buildResult.status)}); not writing pidfile.\n`,
        );
        process.exit(1);
        return;
      }
    }
  }

  const subCmd = dev ? 'dev' : 'start';
  const args = ['next', subCmd, '-p', String(port), '-H', host];

  // Pass through the env explicitly so we can scope it; importantly include
  // AGENT_OS_DB (so the dashboard hits the same SQLite the CLI does) and
  // AGENT_OS_DASHBOARD_TOKEN (so middleware can verify bearer tokens).
  const childEnv: NodeJS.ProcessEnv = { ...process.env };

  const spawnOpts: SpawnOptions = {
    cwd: webDir,
    env: childEnv,
    detached: true,
    stdio: ['ignore', 'inherit', 'inherit'],
  };

  const child = spawn('npx', args, spawnOpts);
  if (typeof child.pid !== 'number') {
    process.stderr.write('failed to spawn next: no pid returned\n');
    process.exit(1);
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot();
  const pidPath = pidfilePath(workspaceRoot);
  mkdirSync(dirname(pidPath), { recursive: true });
  writeFileSync(pidPath, `${String(child.pid)}\n`, 'utf8');

  // Detach so the parent CLI can exit without killing the dashboard.
  child.unref();

  process.stdout.write(
    `dashboard started: http://${host}:${String(port)}  (pid ${String(child.pid)})\n`,
  );
  process.stdout.write('stop with: agent-os dashboard stop\n');
}

/**
 * `dashboard stop` implementation. Idempotent: missing pidfile and stale
 * pidfile both exit 0. Only a successful SIGTERM removes the pidfile and
 * reports the killed pid.
 */
function runStop(): void {
  const workspaceRoot = resolveWorkspaceRoot();
  const pidPath = pidfilePath(workspaceRoot);

  if (!existsSync(pidPath)) {
    process.stderr.write('no dashboard running (no pidfile)\n');
    return;
  }

  const raw = readFileSync(pidPath, 'utf8').trim();
  const pid = Number.parseInt(raw, 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    process.stderr.write(`invalid pidfile contents at ${pidPath}: "${raw}" — removing\n`);
    rmSync(pidPath, { force: true });
    return;
  }

  // `process.kill(pid, 0)` is a liveness probe. If it throws, the process is
  // gone — clean up the stale pidfile and report.
  try {
    process.kill(pid, 0);
  } catch {
    process.stderr.write('no dashboard running (stale pidfile removed)\n');
    rmSync(pidPath, { force: true });
    return;
  }

  process.kill(pid, 'SIGTERM');
  rmSync(pidPath, { force: true });
  process.stdout.write(`dashboard stopped (pid ${String(pid)})\n`);
}

export function buildDashboardCommand(): Command {
  const cmd = new Command('dashboard');
  cmd.description(
    'Optional local dashboard (Phase 15). Not started by any other command — must be invoked explicitly.',
  );

  cmd
    .command('start')
    .description(
      'Start the local web dashboard (binds to 127.0.0.1 by default; requires AGENT_OS_DASHBOARD_TOKEN for non-loopback hosts).',
    )
    .option('--host <host>', 'Interface to bind', DEFAULT_HOST)
    .option('--port <port>', 'TCP port to bind', String(DEFAULT_PORT))
    .option('--dev', 'Run `next dev` instead of `next start`', false)
    .action((options: DashboardStartOptions) => {
      try {
        runStart(options);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`agent-os dashboard start: ${message}\n`);
        process.exit(1);
      }
    });

  cmd
    .command('stop')
    .description('Stop the local web dashboard if running (idempotent).')
    .action(() => {
      try {
        runStop();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`agent-os dashboard stop: ${message}\n`);
        process.exit(1);
      }
    });

  return cmd;
}
