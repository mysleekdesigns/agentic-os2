import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  runSandboxed,
  validateSandboxInput,
  type SandboxConfig,
} from '../../src/security/index.js';

const repoRoot = fs.realpathSync(path.resolve(__dirname, '..', '..'));

function baseConfig(over: Partial<SandboxConfig> = {}): SandboxConfig {
  return {
    cwdAllowlist: [repoRoot],
    commandAllowlist: ['node'],
    timeoutMs: 10_000,
    maxBufferBytes: 1_048_576,
    ...over,
  };
}

describe('runSandboxed — happy path', () => {
  it('runs an allow-listed command in an allow-listed cwd', async () => {
    const result = await runSandboxed(
      { command: 'node', args: ['-e', "console.log('hi')"], cwd: repoRoot },
      baseConfig(),
    );
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hi');
    expect(result.truncated).toBe(false);
  });
});

describe('runSandboxed — cwd not allowed', () => {
  it('rejects a cwd outside the allow-list', async () => {
    const outside = fs.realpathSync(os.tmpdir());
    const result = await runSandboxed(
      { command: 'node', args: ['-e', 'console.log(1)'], cwd: outside },
      baseConfig({ cwdAllowlist: [path.join(repoRoot, 'src')] }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('cwd_not_allowed');
  });
});

describe('runSandboxed — command not allowed', () => {
  it('rejects a command not in the allow-list', async () => {
    const result = await runSandboxed(
      { command: 'rm', args: ['-rf', '/'], cwd: repoRoot },
      baseConfig({ commandAllowlist: ['node'] }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('command_not_allowed');
  });

  it('rejects an absolute command path even if the basename is allowed', async () => {
    const result = await runSandboxed(
      { command: '/bin/ls', args: [], cwd: repoRoot },
      baseConfig({ commandAllowlist: ['ls', '/bin/ls'] }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('command_not_allowed');
  });
});

describe('runSandboxed — timeout', () => {
  it('returns timeout when child runs longer than timeoutMs', async () => {
    const result = await runSandboxed(
      { command: 'node', args: ['-e', 'setTimeout(()=>{}, 5000)'], cwd: repoRoot },
      baseConfig({ timeoutMs: 200 }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('timeout');
  }, 10_000);
});

describe('runSandboxed — output too large', () => {
  it('kills the child and reports output_too_large when stdout exceeds maxBufferBytes', async () => {
    // Print ~50 KiB repeatedly; with a 1 KiB cap we should overflow quickly.
    const script =
      "const chunk = 'x'.repeat(1024); const t = setInterval(() => process.stdout.write(chunk), 5); setTimeout(()=>clearInterval(t), 2000);";
    const result = await runSandboxed(
      { command: 'node', args: ['-e', script], cwd: repoRoot },
      baseConfig({ maxBufferBytes: 1024, timeoutMs: 5_000 }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('output_too_large');
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(1024);
  }, 10_000);
});

describe('runSandboxed — non-zero exit', () => {
  it('reports exit_nonzero with the actual exit code', async () => {
    const result = await runSandboxed(
      { command: 'node', args: ['-e', 'process.exit(2)'], cwd: repoRoot },
      baseConfig(),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('exit_nonzero');
    expect(result.exitCode).toBe(2);
  });
});

describe('validateSandboxInput — pure', () => {
  it('does not spawn anything; returns ok for a valid input', () => {
    const result = validateSandboxInput({ command: 'node', args: [], cwd: repoRoot }, baseConfig());
    expect(result.ok).toBe(true);
  });

  it('returns command_not_allowed for a path separator in the command', () => {
    const result = validateSandboxInput(
      { command: '/bin/ls', cwd: repoRoot },
      baseConfig({ commandAllowlist: ['ls'] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('command_not_allowed');
      expect(result.detail).toMatch(/bare name/);
    }
  });

  it('returns cwd_not_allowed for a cwd outside the allow-list', () => {
    const outside = fs.realpathSync(os.tmpdir());
    const result = validateSandboxInput(
      { command: 'node', cwd: outside },
      baseConfig({ cwdAllowlist: [path.join(repoRoot, 'src')] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('cwd_not_allowed');
    }
  });
});

describe('runSandboxed — env scrubbing', () => {
  const SECRET_KEY = 'SECRET_TEST_XYZ';
  const SECRET_VAL = 'super-secret-do-not-leak';
  let hadPrior = false;
  let priorVal: string | undefined;

  beforeAll(() => {
    hadPrior = SECRET_KEY in process.env;
    priorVal = process.env[SECRET_KEY];
    process.env[SECRET_KEY] = SECRET_VAL;
  });

  afterAll(() => {
    if (hadPrior) {
      process.env[SECRET_KEY] = priorVal;
    } else {
      delete process.env[SECRET_KEY];
    }
  });

  it('does not forward arbitrary parent env vars to the child', async () => {
    const result = await runSandboxed(
      {
        command: 'node',
        args: ['-e', `console.log(process.env.${SECRET_KEY} ?? 'unset')`],
        cwd: repoRoot,
      },
      baseConfig(),
    );
    expect(result.ok).toBe(true);
    expect(result.stdout.trim()).toBe('unset');
    expect(result.stdout).not.toContain(SECRET_VAL);
  });
});
