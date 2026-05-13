/**
 * Phase 11 — Secrets handling.
 *
 * The auditor's `redactSecrets` is the seam that scrubs payloads on their way
 * to the BlobStore (and via the span emitter, to `traces.otel_span_json`).
 * Phase 4 only redacted by KEY name and by vendor-shaped string patterns.
 * Phase 11 adds a third pass: for every env-var in a small provider passlist
 * (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CLAUDE_API_KEY`), the live value is
 * substring-stripped from any string under redaction. This guards against
 * accidental leakage when the user is in API mode — a header echo, a stack
 * trace, or an MCP tool result that included the key value verbatim.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type AgentOsDb } from '../../../src/storage/db.js';
import { runMigrations } from '../../../src/storage/migrate.js';
import { agents, runs, traces } from '../../../src/storage/schema.js';
import { getGuardedSecrets, redactSecrets } from '../../../src/core/tools/audit.js';
import { createSpanEmitter } from '../../../src/core/observability/emitter.js';

const ANTHROPIC_KEY = 'sk-ant-very-long-key-xxxxx';
const OPENAI_KEY = 'sk-openai-very-long-key-12345';
const CLAUDE_KEY = 'sk-claude-very-long-key-67890';

describe('getGuardedSecrets', () => {
  it('returns the values for every provider env-var that is set and long enough', () => {
    const env: NodeJS.ProcessEnv = {
      ANTHROPIC_API_KEY: ANTHROPIC_KEY,
      OPENAI_API_KEY: OPENAI_KEY,
      CLAUDE_API_KEY: CLAUDE_KEY,
    };
    const secrets = getGuardedSecrets(env);
    expect(secrets).toContain(ANTHROPIC_KEY);
    expect(secrets).toContain(OPENAI_KEY);
    expect(secrets).toContain(CLAUDE_KEY);
  });

  it('skips empty / missing env-vars', () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: '' };
    expect(getGuardedSecrets(env)).toEqual([]);
  });

  it('applies the length guard (≥12 chars)', () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: 'sk-shorty' };
    expect(getGuardedSecrets(env)).toEqual([]);
  });

  it('deduplicates identical values across env-var names', () => {
    const env: NodeJS.ProcessEnv = {
      ANTHROPIC_API_KEY: ANTHROPIC_KEY,
      CLAUDE_API_KEY: ANTHROPIC_KEY,
    };
    expect(getGuardedSecrets(env)).toEqual([ANTHROPIC_KEY]);
  });
});

describe('redactSecrets — env-value substring redaction', () => {
  it('scrubs ANTHROPIC_API_KEY embedded in a plain string', () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: ANTHROPIC_KEY };
    const out = redactSecrets(`header: Bearer ${ANTHROPIC_KEY}`, env) as string;
    expect(out).not.toContain(ANTHROPIC_KEY);
    expect(out).toContain('<redacted>');
  });

  it('scrubs OPENAI_API_KEY embedded in a plain string', () => {
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: OPENAI_KEY };
    const out = redactSecrets(`authorization=${OPENAI_KEY}`, env) as string;
    expect(out).not.toContain(OPENAI_KEY);
    expect(out).toContain('<redacted>');
  });

  it('scrubs CLAUDE_API_KEY (also in the guarded list)', () => {
    const env: NodeJS.ProcessEnv = { CLAUDE_API_KEY: CLAUDE_KEY };
    const out = redactSecrets(`token: ${CLAUDE_KEY}`, env) as string;
    expect(out).not.toContain(CLAUDE_KEY);
    expect(out).toContain('<redacted>');
  });

  it('scrubs a nested-object value containing the env secret', () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: ANTHROPIC_KEY };
    const out = redactSecrets(
      {
        request: {
          headers: {
            // Use a non-secret-named key so the key-based pass does not fire;
            // we want the env-value pass to be the thing that scrubs.
            misc: `x-api-trace ${ANTHROPIC_KEY} continues here`,
          },
        },
      },
      env,
    ) as Record<string, unknown>;
    const headers = (out.request as Record<string, unknown>).headers as Record<string, unknown>;
    expect(headers.misc as string).not.toContain(ANTHROPIC_KEY);
    expect(headers.misc as string).toContain('<redacted>');
  });

  it('does not use a short env value for substring redaction (length guard)', () => {
    // A short value would otherwise nuke unrelated substrings; the length
    // guard exists precisely so that does not happen.
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: 'abcdefghijk' }; // 11 chars
    const out = redactSecrets('hello abcdefghijk world', env) as string;
    expect(out).toBe('hello abcdefghijk world');
  });

  it('is a no-op when the env-var is empty / missing', () => {
    const env: NodeJS.ProcessEnv = {};
    const out = redactSecrets('plain string with no secrets', env) as string;
    expect(out).toBe('plain string with no secrets');
  });

  it('preserves the existing key-name-based redaction (regression)', () => {
    const env: NodeJS.ProcessEnv = {}; // nothing in env — only the key pass matters
    const out = redactSecrets(
      {
        api_key: 'literal-secret-value',
        password: 'hunter2',
        nested: { token: 't', innocent: 1 },
      },
      env,
    ) as Record<string, unknown>;
    expect(out.api_key).toBe('<redacted>');
    expect(out.password).toBe('<redacted>');
    expect((out.nested as Record<string, unknown>).token).toBe('<redacted>');
    expect((out.nested as Record<string, unknown>).innocent).toBe(1);
  });

  it('preserves the existing vendor-pattern redaction (regression)', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(redactSecrets('use sk-AAAABBBBCCCCDDDDEEEE for now', env)).toMatch(/<redacted>/);
    expect(redactSecrets('Authorization: Bearer abcdef0123456789ZZZZ', env)).toMatch(/<redacted>/);
  });

  it('falls back to process.env when no env is supplied', () => {
    const prior = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = ANTHROPIC_KEY;
    try {
      const out = redactSecrets(`raw ${ANTHROPIC_KEY} embedded`) as string;
      expect(out).not.toContain(ANTHROPIC_KEY);
      expect(out).toContain('<redacted>');
    } finally {
      if (prior === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = prior;
      }
    }
  });
});

describe('span emitter — secret scrubbing on persistence', () => {
  let db: AgentOsDb;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agent-os-span-redact-'));
    db = openDatabase(':memory:', { noWal: true });
    await runMigrations(db, { log: () => undefined });
    await db.insert(agents).values({
      id: 'tester',
      version: '1',
      definitionPath: '',
      hash: '',
      createdAt: new Date(),
    });
    await db.insert(runs).values({
      id: 'run-1',
      agentId: 'tester',
      status: 'running',
      startedAt: new Date(),
      provider: 'anthropic_api',
      model: 'claude-opus',
    });
  });

  afterEach(() => {
    db.$sqlite.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('strips the live ANTHROPIC_API_KEY from a persisted span attribute', async () => {
    const prior = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = ANTHROPIC_KEY;
    try {
      const emitter = createSpanEmitter({ db });
      const ctx = emitter.start({
        kind: 'agent',
        name: 'test-span',
        runId: 'run-1',
        attributes: {
          // A leaked header echo — exactly the shape the API-mode redaction
          // is meant to catch.
          'http.request.header.authorization': `Bearer ${ANTHROPIC_KEY}`,
        },
      });
      emitter.recordEvent(ctx, 'leak', { detail: `also here ${ANTHROPIC_KEY}` });
      emitter.end(ctx, 'ok');
      await emitter.flush();

      const rows = await db.select().from(traces);
      expect(rows).toHaveLength(1);
      const json = rows[0]!.otelSpanJson;
      expect(json).not.toContain(ANTHROPIC_KEY);
      expect(json).toContain('<redacted>');
    } finally {
      if (prior === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = prior;
      }
    }
  });
});
