/**
 * Sandboxed shell execution helper.
 *
 * PRD §Phase 12 — Security hardening. Provides a tightly constrained way to
 * run a child process from Agent OS tools/skills:
 *
 *   - cwd must be (or descend from) an entry in an explicit allow-list.
 *   - argv[0] must be an exact bare command name in an allow-list; absolute
 *     paths (`/bin/ls`, `C:\\Windows\\System32\\cmd.exe`) are rejected to
 *     prevent allow-list bypass.
 *   - no shell — `shell: false`, no metacharacter interpretation.
 *   - env is scrubbed to a minimal set unless the caller overrides; parent
 *     env is NEVER forwarded wholesale.
 *   - stdout/stderr are bounded; overflow kills the child with SIGKILL.
 *   - a hard wall-clock timeout is enforced by `child_process.spawn`.
 *
 * The validator `validateSandboxInput` is a pure function suitable for tests
 * and policy probes; it does not spawn anything.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface SandboxConfig {
  /** Absolute paths. The resolved cwd must equal one of these or be a descendant. */
  cwdAllowlist: readonly string[];
  /** Exact bare command names (argv[0]); e.g. ['ls', 'cat', 'git']. */
  commandAllowlist: readonly string[];
  /** Wall-clock timeout in ms. Default 10_000. */
  timeoutMs?: number;
  /** Max bytes captured for stdout AND stderr. Default 1 MiB each. */
  maxBufferBytes?: number;
  /** Env overrides. Defaults to a scrubbed minimal env (PATH, LANG, LC_ALL). */
  env?: NodeJS.ProcessEnv;
}

export interface SandboxRunInput {
  command: string;
  args?: readonly string[];
  /** Must be absolute. */
  cwd: string;
  stdin?: string;
}

export type SandboxFailureReason =
  | 'cwd_not_allowed'
  | 'command_not_allowed'
  | 'timeout'
  | 'exit_nonzero'
  | 'spawn_failed'
  | 'output_too_large';

export interface SandboxResult {
  ok: boolean;
  reason?: SandboxFailureReason;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
}

export type ValidateOk = { ok: true };
export type ValidateErr = {
  ok: false;
  reason: 'cwd_not_allowed' | 'command_not_allowed';
  detail: string;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BUFFER_BYTES = 1_048_576;

function hasPathSeparator(cmd: string): boolean {
  return cmd.includes('/') || cmd.includes('\\');
}

function resolveExisting(p: string): string {
  // Resolve symlinks if the path exists; otherwise return the resolved
  // (non-real) path so the caller can produce a precise error.
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    return abs;
  }
}

function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  if (rel === '') return true;
  if (rel.startsWith('..')) return false;
  return !path.isAbsolute(rel);
}

/**
 * Pure validator. Does not spawn anything. Use this from policy probes or
 * tests to confirm an invocation would be accepted by the sandbox without
 * incurring process-spawn cost.
 */
export function validateSandboxInput(
  input: SandboxRunInput,
  config: SandboxConfig,
): ValidateOk | ValidateErr {
  if (hasPathSeparator(input.command)) {
    return {
      ok: false,
      reason: 'command_not_allowed',
      detail: `command must be a bare name, got "${input.command}"`,
    };
  }
  if (!config.commandAllowlist.includes(input.command)) {
    return {
      ok: false,
      reason: 'command_not_allowed',
      detail: `command "${input.command}" is not in the allow-list`,
    };
  }
  if (!path.isAbsolute(input.cwd)) {
    return {
      ok: false,
      reason: 'cwd_not_allowed',
      detail: `cwd must be absolute, got "${input.cwd}"`,
    };
  }
  const resolvedCwd = resolveExisting(input.cwd);
  const resolvedAllow = config.cwdAllowlist.map((p) => resolveExisting(p));
  const allowed = resolvedAllow.some((root) => isWithin(root, resolvedCwd));
  if (!allowed) {
    return {
      ok: false,
      reason: 'cwd_not_allowed',
      detail: `cwd "${resolvedCwd}" is not under any allow-listed root`,
    };
  }
  return { ok: true };
}

function defaultScrubbedEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    LANG: process.env.LANG ?? 'C',
    LC_ALL: 'C',
  };
}

/**
 * Spawn a child process under the sandbox. See module doc for the full set
 * of constraints applied.
 */
export async function runSandboxed(
  input: SandboxRunInput,
  config: SandboxConfig,
): Promise<SandboxResult> {
  const start = Date.now();
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBufferBytes = config.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;

  const validation = validateSandboxInput(input, config);
  if (!validation.ok) {
    return {
      ok: false,
      reason: validation.reason,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: validation.detail,
      durationMs: Date.now() - start,
      truncated: false,
    };
  }

  // cwd must exist on disk to spawn. Re-check after validation passed (the
  // validator resolves a non-existent path back to its absolute form rather
  // than failing — we want a precise spawn_failed here).
  const absCwd = path.resolve(input.cwd);
  if (!fs.existsSync(absCwd)) {
    return {
      ok: false,
      reason: 'spawn_failed',
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: `cwd does not exist: ${absCwd}`,
      durationMs: Date.now() - start,
      truncated: false,
    };
  }
  const resolvedCwd = fs.realpathSync(absCwd);

  const env = config.env ?? defaultScrubbedEnv();
  const args = input.args ? [...input.args] : [];

  return new Promise<SandboxResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let killedForOverflow = false;
    let settled = false;

    const child = spawn(input.command, args, {
      cwd: resolvedCwd,
      env,
      shell: false,
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const settle = (result: SandboxResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      if (killedForOverflow) return;
      const remaining = maxBufferBytes - stdoutBytes;
      if (chunk.byteLength <= remaining) {
        stdout += chunk.toString('utf8');
        stdoutBytes += chunk.byteLength;
        return;
      }
      // Truncate to remaining bytes, mark overflow, kill.
      if (remaining > 0) {
        stdout += chunk.subarray(0, remaining).toString('utf8');
        stdoutBytes += remaining;
      }
      truncated = true;
      killedForOverflow = true;
      child.kill('SIGKILL');
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (killedForOverflow) return;
      const remaining = maxBufferBytes - stderrBytes;
      if (chunk.byteLength <= remaining) {
        stderr += chunk.toString('utf8');
        stderrBytes += chunk.byteLength;
        return;
      }
      if (remaining > 0) {
        stderr += chunk.subarray(0, remaining).toString('utf8');
        stderrBytes += remaining;
      }
      truncated = true;
      killedForOverflow = true;
      child.kill('SIGKILL');
    });

    child.on('error', (err) => {
      settle({
        ok: false,
        reason: 'spawn_failed',
        exitCode: null,
        signal: null,
        stdout,
        stderr: stderr || (err instanceof Error ? err.message : String(err)),
        durationMs: Date.now() - start,
        truncated,
      });
    });

    child.on('close', (code, signal) => {
      const durationMs = Date.now() - start;
      if (killedForOverflow) {
        settle({
          ok: false,
          reason: 'output_too_large',
          exitCode: code,
          signal,
          stdout,
          stderr,
          durationMs,
          truncated: true,
        });
        return;
      }
      // node's spawn with `timeout` kills the child with SIGTERM on timeout.
      if (signal === 'SIGTERM' && durationMs >= timeoutMs - 50) {
        settle({
          ok: false,
          reason: 'timeout',
          exitCode: code,
          signal,
          stdout,
          stderr,
          durationMs,
          truncated,
        });
        return;
      }
      if (code === 0 && signal === null) {
        settle({
          ok: true,
          exitCode: 0,
          signal: null,
          stdout,
          stderr,
          durationMs,
          truncated,
        });
        return;
      }
      settle({
        ok: false,
        reason: 'exit_nonzero',
        exitCode: code,
        signal,
        stdout,
        stderr,
        durationMs,
        truncated,
      });
    });

    if (input.stdin !== undefined) {
      child.stdin.end(input.stdin);
    } else {
      child.stdin.end();
    }
  });
}
