import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildInitCommand, runInit, type InitResult } from '../../src/cli/commands/init.js';
import { loadConfig } from '../../src/config/index.js';

const EXPECTED_DIRECTORIES = [
  'agents',
  'agents/templates',
  'agents/examples',
  'workflows',
  'workflows/examples',
  'evals',
  'evals/fixtures',
  'evals/results',
  'memory',
  'logs',
  'blobs',
  '.agent-os',
];

describe('runInit', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agent-os-init-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('scaffolds all expected directories, gitkeeps, and a valid default config', () => {
    const result = runInit({ cwd: tmpDir });

    expect(result.workspace).toBe(tmpDir);
    expect(result.config).toBe('created');

    for (const relative of EXPECTED_DIRECTORIES) {
      const abs = join(tmpDir, relative);
      expect(existsSync(abs)).toBe(true);
      const entry = result.directories.find((d) => d.path === abs);
      expect(entry).toBeDefined();
      expect(entry?.status).toBe('created');
    }

    // .gitkeep files should land in the directories the brief calls out.
    for (const relative of ['agents', 'workflows', 'evals/fixtures']) {
      expect(existsSync(join(tmpDir, relative, '.gitkeep'))).toBe(true);
    }

    const configPath = join(tmpDir, 'agent-os.config.yaml');
    expect(existsSync(configPath)).toBe(true);

    // The written config must round-trip through the loader cleanly.
    const config = loadConfig(configPath, { env: {} });
    expect(config.runtime.default_provider).toBe('claude_code_local');
    expect(config.providers.claude_code_local.enabled).toBe(true);
    expect(config.security.risk_levels.destructive).toBe('deny');
  });

  it('is idempotent on a second run: directories report `exists` and config is `skipped`', () => {
    runInit({ cwd: tmpDir });
    const second = runInit({ cwd: tmpDir });

    expect(second.config).toBe('skipped');
    for (const dir of second.directories) {
      expect(dir.status).toBe('exists');
    }
  });

  it('overwrites the config when --force is set', () => {
    runInit({ cwd: tmpDir });

    const configPath = join(tmpDir, 'agent-os.config.yaml');
    // Mutate the on-disk config so we can detect that --force re-wrote it.
    writeFileSync(configPath, '# tampered\n');

    const forced = runInit({ cwd: tmpDir, force: true });
    expect(forced.config).toBe('overwrote');

    const rewritten = readFileSync(configPath, 'utf8');
    expect(rewritten).not.toBe('# tampered\n');
    expect(rewritten).toContain('default_provider: claude_code_local');
  });

  it('returns a structured InitResult shape suitable for --json output', () => {
    const result: InitResult = runInit({ cwd: tmpDir });

    expect(typeof result.workspace).toBe('string');
    expect(Array.isArray(result.directories)).toBe(true);
    expect(result.directories.length).toBe(EXPECTED_DIRECTORIES.length);
    for (const dir of result.directories) {
      expect(typeof dir.path).toBe('string');
      expect(['created', 'exists']).toContain(dir.status);
    }
    expect(['created', 'skipped', 'overwrote']).toContain(result.config);

    // JSON-serializable end-to-end.
    const roundTripped = JSON.parse(JSON.stringify(result)) as InitResult;
    expect(roundTripped.workspace).toBe(result.workspace);
    expect(roundTripped.config).toBe(result.config);
  });
});

describe('buildInitCommand', () => {
  it('produces a Commander command named "init" with the documented options', () => {
    const cmd = buildInitCommand();
    expect(cmd.name()).toBe('init');

    const optionFlags = cmd.options.map((o) => o.long);
    expect(optionFlags).toContain('--cwd');
    expect(optionFlags).toContain('--force');
    expect(optionFlags).toContain('--json');
  });
});
