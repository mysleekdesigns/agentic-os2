import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { AgentOsConfigSchema } from '../src/config/schema.js';

const REPO_ROOT_CONFIG = resolve(__dirname, '..', 'agent-os.config.yaml');

describe('loadConfig', () => {
  it('loads and validates the shipped agent-os.config.yaml', () => {
    // Pass an empty env so the test result does not depend on whatever the
    // host shell happens to have exported.
    const config = loadConfig(REPO_ROOT_CONFIG, { env: {} });

    expect(config.runtime.default_provider).toBe('claude_code_local');
    expect(config.providers.claude_code_local.enabled).toBe(true);
    expect(config.security.risk_levels.destructive).toBe('deny');
    expect(config.security.risk_levels.read).toBe('allow');
    expect(config.approvals.channels).toContain('cli');
  });
});

describe('loadConfig env overlay', () => {
  it('overrides a string YAML value via AGENT_OS_DEFAULT_PROVIDER', () => {
    const config = loadConfig(REPO_ROOT_CONFIG, {
      env: { AGENT_OS_DEFAULT_PROVIDER: 'anthropic_api' },
    });
    expect(config.runtime.default_provider).toBe('anthropic_api');
  });

  it('overrides a boolean YAML value via AGENT_OS_REQUIRE_APPROVAL_FOR_RISKY_TOOLS=false', () => {
    const config = loadConfig(REPO_ROOT_CONFIG, {
      env: { AGENT_OS_REQUIRE_APPROVAL_FOR_RISKY_TOOLS: 'false' },
    });
    expect(config.runtime.require_approval_for_risky_tools).toBe(false);
  });

  it('accepts the various truthy/falsy boolean spellings', () => {
    for (const truthy of ['1', 'true', 'YES', 'on']) {
      const config = loadConfig(REPO_ROOT_CONFIG, {
        env: { AGENT_OS_OTLP_ENABLED: truthy },
      });
      expect(config.observability.otlp_exporter.enabled).toBe(true);
    }
    for (const falsy of ['0', 'False', 'no', 'OFF']) {
      const config = loadConfig(REPO_ROOT_CONFIG, {
        env: { AGENT_OS_OTLP_ENABLED: falsy },
      });
      expect(config.observability.otlp_exporter.enabled).toBe(false);
    }
  });

  it('throws a descriptive error for an invalid boolean env var', () => {
    expect(() =>
      loadConfig(REPO_ROOT_CONFIG, {
        env: { AGENT_OS_REQUIRE_APPROVAL_FOR_RISKY_TOOLS: 'maybe' },
      }),
    ).toThrow(/AGENT_OS_REQUIRE_APPROVAL_FOR_RISKY_TOOLS.*maybe/);
  });

  it('threads provider enable flags into the typed config', () => {
    const config = loadConfig(REPO_ROOT_CONFIG, {
      env: {
        AGENT_OS_ANTHROPIC_API_ENABLED: 'true',
        AGENT_OS_OPENAI_API_ENABLED: '1',
      },
    });
    expect(config.providers.anthropic_api.enabled).toBe(true);
    expect(config.providers.openai_api.enabled).toBe(true);
  });

  it('threads observability OTLP endpoint through the overlay', () => {
    const config = loadConfig(REPO_ROOT_CONFIG, {
      env: {
        AGENT_OS_OTLP_ENABLED: 'true',
        AGENT_OS_OTLP_ENDPOINT: 'https://otel.example.com:4318',
      },
    });
    expect(config.observability.otlp_exporter.enabled).toBe(true);
    expect(config.observability.otlp_exporter.endpoint).toBe('https://otel.example.com:4318');
  });

  it('ignores ANTHROPIC_API_KEY / OPENAI_API_KEY — the loader works with or without them', () => {
    const withKeys = loadConfig(REPO_ROOT_CONFIG, {
      env: {
        ANTHROPIC_API_KEY: 'sk-ant-should-be-ignored',
        OPENAI_API_KEY: 'sk-openai-should-be-ignored',
      },
    });
    const withoutKeys = loadConfig(REPO_ROOT_CONFIG, { env: {} });

    expect(withKeys).toEqual(withoutKeys);
    // Sanity: the enable flags stay at their YAML-defined values regardless.
    expect(withKeys.providers.anthropic_api.enabled).toBe(false);
    expect(withKeys.providers.openai_api.enabled).toBe(false);
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
