import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { AgentOsConfigSchema } from '../src/config/schema.js';

const REPO_ROOT_CONFIG = resolve(__dirname, '..', 'agent-os.config.yaml');

describe('loadConfig', () => {
  it('loads and validates the shipped agent-os.config.yaml', () => {
    const config = loadConfig(REPO_ROOT_CONFIG);

    expect(config.runtime.default_provider).toBe('claude_code_local');
    expect(config.providers.claude_code_local.enabled).toBe(true);
    expect(config.security.risk_levels.destructive).toBe('deny');
    expect(config.security.risk_levels.read).toBe('allow');
    expect(config.approvals.channels).toContain('cli');
  });
});

describe('AgentOsConfigSchema', () => {
  it('rejects a config with an invalid risk level value', () => {
    const bad = {
      security: {
        risk_levels: {
          // not a member of allow | approval_required | deny
          write: 'sometimes',
        },
      },
    };

    const result = AgentOsConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      const hasRiskLevelIssue = result.error.issues.some((issue) =>
        issue.path.join('.').startsWith('security.risk_levels.write'),
      );
      expect(hasRiskLevelIssue).toBe(true);
    }
  });
});
