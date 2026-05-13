/**
 * Phase 12 — Security hardening.
 *
 * `security.secret_patterns` is operator-supplied; the config loader
 * validates every entry compiles as a JS regex at load time so a mistyped
 * pattern surfaces as a clear error before any run scrubs payloads.
 */
import { describe, expect, it } from 'vitest';

import { AgentOsConfigSchema, SecurityConfigSchema } from '../../src/config/schema.js';

describe('SecurityConfigSchema — secret_patterns', () => {
  it('accepts valid regex strings', () => {
    const result = SecurityConfigSchema.safeParse({
      secret_patterns: ['foo', '\\d+', 'SECRET_[A-Z0-9]+'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.secret_patterns).toEqual(['foo', '\\d+', 'SECRET_[A-Z0-9]+']);
    }
  });

  it('defaults to [] when omitted', () => {
    const result = SecurityConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.secret_patterns).toEqual([]);
    }
  });

  it('rejects an invalid regex with a clear error mentioning secret_patterns', () => {
    const result = AgentOsConfigSchema.safeParse({
      security: {
        secret_patterns: ['['],
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const flat = result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      }));
      const match = flat.find((f) => f.path.includes('secret_patterns'));
      expect(match).toBeDefined();
      expect(match!.message).toMatch(/secret_patterns/);
      expect(match!.message).toMatch(/valid regex/);
    }
  });

  it('reports the offending index for an invalid pattern', () => {
    const result = SecurityConfigSchema.safeParse({
      secret_patterns: ['valid', '(unterminated'],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join('.').startsWith('secret_patterns'));
      expect(issue).toBeDefined();
      expect(issue!.path).toContain(1);
    }
  });

  it('flows the field through the top-level schema with a default', () => {
    const result = AgentOsConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.security.secret_patterns).toEqual([]);
    }
  });
});
