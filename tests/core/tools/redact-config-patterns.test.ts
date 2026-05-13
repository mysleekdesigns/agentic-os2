/**
 * Phase 12 — operator-configurable secret patterns.
 *
 * The auditor's `redactSecrets` / `redactSecretValues` accept an
 * `extraPatterns` list sourced from `security.secret_patterns` in
 * `agent-os.config.yaml`. Patterns are applied after the built-in vendor
 * scrubbers (so existing behaviour is unchanged) and run against every string
 * value reached by the redactor — including nested objects and arrays.
 */
import { describe, expect, it } from 'vitest';

import { redactSecrets, redactSecretValues } from '../../../src/core/tools/audit.js';

describe('redactSecrets — operator-supplied secret_patterns', () => {
  it('scrubs a value matching a user-supplied pattern', () => {
    const out = redactSecrets('hello SECRET_ABC123 world', {
      env: {},
      extraPatterns: ['\\bSECRET_[A-Z0-9]+\\b'],
    }) as string;
    expect(out).not.toContain('SECRET_ABC123');
    expect(out).toContain('<redacted>');
  });

  it('applies multiple patterns independently', () => {
    const out = redactSecrets('foo=AAA111 bar=BBB222 baz untouched', {
      env: {},
      extraPatterns: ['AAA\\d+', 'BBB\\d+'],
    }) as string;
    expect(out).not.toContain('AAA111');
    expect(out).not.toContain('BBB222');
    expect(out).toContain('baz untouched');
    // Two replacements -> two <redacted> markers.
    expect(out.match(/<redacted>/g)?.length).toBe(2);
  });

  it('silently skips invalid pattern strings at redaction time (no throw)', () => {
    let out: unknown;
    expect(() => {
      out = redactSecrets('keep my XYZ123 token', {
        env: {},
        // `[` is unterminated and `(` opens a group with no close — both invalid.
        extraPatterns: ['[', '(', 'XYZ\\d+'],
      });
    }).not.toThrow();
    expect(out as string).not.toContain('XYZ123');
    expect(out as string).toContain('<redacted>');
  });

  it('applies user patterns inside nested objects and arrays', () => {
    const out = redactSecrets(
      {
        request: {
          body: 'token: SECRET_ABC123',
          tags: ['SECRET_DEF456', 'innocent'],
        },
      },
      { env: {}, extraPatterns: ['SECRET_[A-Z0-9]+'] },
    ) as Record<string, unknown>;
    const request = out.request as Record<string, unknown>;
    expect(request.body as string).not.toContain('SECRET_ABC123');
    expect(request.body as string).toContain('<redacted>');
    const tags = request.tags as string[];
    expect(tags[0]).toBe('<redacted>');
    expect(tags[1]).toBe('innocent');
  });

  it('combines with env-var passlist and built-in vendor patterns', () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: 'sk-ant-very-long-key-xxx' };
    const input = [
      'live key sk-ant-very-long-key-xxx here',
      'vendor sk-AAAABBBBCCCCDDDDEEEE there',
      'custom SECRET_ABC123 elsewhere',
    ].join(' | ');
    const out = redactSecrets(input, {
      env,
      extraPatterns: ['SECRET_[A-Z0-9]+'],
    }) as string;
    expect(out).not.toContain('sk-ant-very-long-key-xxx');
    expect(out).not.toContain('sk-AAAABBBBCCCCDDDDEEEE');
    expect(out).not.toContain('SECRET_ABC123');
    expect(out.match(/<redacted>/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('accepts a pre-compiled RegExp and forces the global flag', () => {
    const out = redactSecrets('A1 and A2 should both go', {
      env: {},
      // Non-global on purpose — the redactor should normalise.
      extraPatterns: [/A\d/],
    }) as string;
    expect(out).not.toContain('A1');
    expect(out).not.toContain('A2');
    expect(out.match(/<redacted>/g)?.length).toBe(2);
  });

  it('redactSecretValues also threads extraPatterns through', () => {
    const out = redactSecretValues(
      { attr: 'SECRET_ABC123 leak' },
      { env: {}, extraPatterns: ['SECRET_[A-Z0-9]+'] },
    ) as Record<string, unknown>;
    expect(out.attr as string).not.toContain('SECRET_ABC123');
    expect(out.attr as string).toContain('<redacted>');
  });

  it('back-compat: positional env arg still works', () => {
    const out = redactSecrets('plain string', { ANTHROPIC_API_KEY: '' }) as string;
    expect(out).toBe('plain string');
  });
});
