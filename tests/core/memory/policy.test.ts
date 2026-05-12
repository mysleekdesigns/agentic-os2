/**
 * Memory access policy tests (PRD §3 Phase 7 — Exit gate).
 *
 * Exercises the pure policy evaluator from the barrel. No DB / fs — only the
 * (optional) `MemoryEventLogger` interface.
 */

import { describe, expect, it } from 'vitest';

import {
  enforceMemoryAccess,
  enforceMemoryAccessOrThrow,
  MemoryPolicyDenied,
  type MemoryEventLogger,
} from '../../../src/core/memory/index.js';
import type { AgentFrontmatter } from '../../../src/core/agents/schema.js';
import type { MemoryAction } from '../../../src/core/memory/index.js';

function makeAgent(
  overrides: Partial<Pick<AgentFrontmatter, 'memory' | 'id'>> = {},
): AgentFrontmatter {
  return {
    id: overrides.id ?? 'test_agent',
    name: 'Test Agent',
    version: 1,
    role: 'tester',
    provider: 'claude_code_local',
    tools: { allowed: [], approval_required: [] },
    permissions: {
      network: 'deny',
      file_read: 'allow',
      file_write: 'deny',
      shell: 'deny',
    },
    memory: overrides.memory ?? { read: [], write: [] },
  };
}

interface RecordedEvent {
  kind: string;
  payload: Record<string, unknown>;
  at: number;
}

function makeRecorder(): { logger: MemoryEventLogger; events: RecordedEvent[] } {
  const events: RecordedEvent[] = [];
  const logger: MemoryEventLogger = {
    emit(args) {
      events.push(args);
    },
  };
  return { logger, events };
}

describe('enforceMemoryAccess — write actions', () => {
  it('returns deny when scope is not in agent.memory.write', () => {
    const agent = makeAgent({ memory: { read: ['project'], write: ['research_notes'] } });
    const { logger, events } = makeRecorder();
    const d = enforceMemoryAccess({
      agent,
      action: 'write',
      scope: 'notes',
      at: 1_700_000_000,
      eventLogger: logger,
    });
    expect(d.outcome).toBe('deny');
    expect(d.scope).toBe('notes');
    expect(d.action).toBe('write');
    expect(d.reason).toMatch(/agent\.memory\.write/);

    // The denial was logged.
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('memory.denied');
    expect(events[0]!.payload).toMatchObject({
      agent_id: 'test_agent',
      action: 'write',
      scope: 'notes',
    });
  });

  it('returns allow when scope is in agent.memory.write', () => {
    const agent = makeAgent({ memory: { read: [], write: ['notes'] } });
    const { logger, events } = makeRecorder();
    const d = enforceMemoryAccess({ agent, action: 'write', scope: 'notes', eventLogger: logger });
    expect(d.outcome).toBe('allow');
    expect(events).toHaveLength(0);
  });
});

describe('enforceMemoryAccess — read-style actions', () => {
  const readishActions: MemoryAction[] = ['read', 'list', 'show', 'search'];
  for (const action of readishActions) {
    it(`returns deny for '${action}' when scope is not in agent.memory.read`, () => {
      const agent = makeAgent({ memory: { read: ['project'], write: [] } });
      const d = enforceMemoryAccess({ agent, action, scope: 'notes' });
      expect(d.outcome).toBe('deny');
      expect(d.reason).toMatch(/agent\.memory\.read/);
    });
    it(`returns allow for '${action}' when scope is in agent.memory.read`, () => {
      const agent = makeAgent({ memory: { read: ['project'], write: [] } });
      const d = enforceMemoryAccess({ agent, action, scope: 'project' });
      expect(d.outcome).toBe('allow');
    });
  }
});

describe('enforceMemoryAccess — rm is a write', () => {
  it("rm against a scope not in memory.write denies (treated as a 'write')", () => {
    const agent = makeAgent({ memory: { read: ['notes'], write: ['scratch'] } });
    const d = enforceMemoryAccess({ agent, action: 'rm', scope: 'notes' });
    expect(d.outcome).toBe('deny');
    expect(d.reason).toMatch(/agent\.memory\.write/);
  });
  it('rm against a scope in memory.write allows', () => {
    const agent = makeAgent({ memory: { read: [], write: ['scratch'] } });
    const d = enforceMemoryAccess({ agent, action: 'rm', scope: 'scratch' });
    expect(d.outcome).toBe('allow');
  });
});

describe('enforceMemoryAccess — exact match only (no wildcards)', () => {
  it("does NOT expand 'note*' to match 'notes'", () => {
    const agent = makeAgent({ memory: { read: [], write: ['note*'] } });
    const d = enforceMemoryAccess({ agent, action: 'write', scope: 'notes' });
    expect(d.outcome).toBe('deny');
  });
  it("matches only the literal 'note*' scope", () => {
    const agent = makeAgent({ memory: { read: [], write: ['note*'] } });
    const d = enforceMemoryAccess({ agent, action: 'write', scope: 'note*' });
    expect(d.outcome).toBe('allow');
  });
});

describe('enforceMemoryAccessOrThrow', () => {
  it('throws MemoryPolicyDenied on deny and logs the denial with the expected payload', () => {
    const agent = makeAgent({ memory: { read: [], write: ['research_notes'] } });
    const { logger, events } = makeRecorder();

    expect(() =>
      enforceMemoryAccessOrThrow({
        agent,
        action: 'write',
        scope: 'notes',
        at: 1_700_000_000,
        eventLogger: logger,
      }),
    ).toThrow(MemoryPolicyDenied);

    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('memory.denied');
    expect(events[0]!.payload).toMatchObject({
      agent_id: agent.id,
      action: 'write',
      scope: 'notes',
      when: 1_700_000_000,
    });
    expect(typeof events[0]!.payload.reason).toBe('string');
  });

  it('returns the allow decision on success', () => {
    const agent = makeAgent({ memory: { read: ['project'], write: [] } });
    const d = enforceMemoryAccessOrThrow({ agent, action: 'read', scope: 'project' });
    expect(d.outcome).toBe('allow');
  });
});
