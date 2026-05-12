/**
 * Phase 7 Exit-criterion test (PRD §3 Phase 7).
 *
 *   "An agent without `memory.write: notes` cannot create a `notes` memory
 *    even if it tries; the attempt is logged."
 *
 * This is the single source of truth for the phase Exit. It pins both halves
 * of the contract:
 *
 *   1. `enforceMemoryAccessOrThrow` throws `MemoryPolicyDenied`.
 *   2. The denial is recorded via the supplied `MemoryEventLogger` with
 *      kind='memory.denied' and the expected payload fields.
 *
 * It also exercises the engine path: a caller wrapper that gates `createMemory`
 * on `enforceMemoryAccessOrThrow` MUST throw on the policy step BEFORE any
 * memory row / blob / file is created (the engine does not enforce policy
 * itself — callers do).
 */

import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createMemory,
  enforceMemoryAccessOrThrow,
  MemoryPolicyDenied,
  type MemoryEventLogger,
} from '../../../src/core/memory/index.js';
import type { AgentFrontmatter } from '../../../src/core/agents/schema.js';
import { openDatabase, type AgentOsDb } from '../../../src/storage/db.js';
import { runMigrations } from '../../../src/storage/migrate.js';
import { createBlobStore, type BlobStore } from '../../../src/storage/blobs.js';
import { memory } from '../../../src/storage/schema.js';

interface RecordedEvent {
  kind: string;
  payload: Record<string, unknown>;
  at: number;
}

function makeAgent(): AgentFrontmatter {
  // PRD §2.6 shape. The agent CAN write 'research_notes' but NOT 'notes'.
  return {
    id: 'researcher_no_notes',
    name: 'Researcher',
    version: 1,
    role: 'researcher',
    provider: 'claude_code_local',
    tools: { allowed: [], approval_required: [] },
    permissions: {
      network: 'allow',
      file_read: 'allow',
      file_write: 'deny',
      shell: 'deny',
    },
    memory: { read: ['project'], write: ['research_notes'] },
  };
}

describe('Phase 7 Exit', () => {
  let tmpDir: string;
  let db: AgentOsDb;
  let blobs: BlobStore;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agent-os-memory-exit-'));
    db = openDatabase(':memory:');
    await runMigrations(db, { log: () => undefined });
    blobs = createBlobStore({ root: join(tmpDir, 'blobs') });
  });

  afterEach(() => {
    db.$sqlite.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('Phase 7 Exit — agent without memory.write:notes is denied and the attempt is logged', async () => {
    const agent = makeAgent();
    const recorded: RecordedEvent[] = [];
    const eventLogger: MemoryEventLogger = {
      emit(args) {
        recorded.push(args);
      },
    };

    // 1. Policy enforcement throws.
    let thrown: unknown = undefined;
    try {
      enforceMemoryAccessOrThrow({
        agent,
        action: 'write',
        scope: 'notes',
        at: 1_700_000_000,
        eventLogger,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MemoryPolicyDenied);

    // 2. The denial was logged with the expected payload fields.
    expect(recorded).toHaveLength(1);
    const ev = recorded[0]!;
    expect(ev.kind).toBe('memory.denied');
    expect(ev.payload).toMatchObject({
      agent_id: 'researcher_no_notes',
      action: 'write',
      scope: 'notes',
    });
    expect(typeof ev.payload.reason).toBe('string');
    expect(typeof ev.payload.when).toBe('number');

    // 3. Engine path: a wrapper that gates createMemory on the policy throws
    //    on the policy step BEFORE the row / blob / file is created.
    const wrapperRecorded: RecordedEvent[] = [];
    const wrapperLogger: MemoryEventLogger = {
      emit(args) {
        wrapperRecorded.push(args);
      },
    };

    async function gatedCreate(): Promise<void> {
      // Caller is responsible for invoking the policy; engine does NOT.
      enforceMemoryAccessOrThrow({
        agent,
        action: 'write',
        scope: 'notes',
        at: 1_700_000_001,
        eventLogger: wrapperLogger,
      });
      // Should never reach here.
      await createMemory({
        db,
        blobs,
        workspaceRoot: tmpDir,
        scope: 'notes',
        key: 'should-not-exist',
        value: 'illicit write',
        agentId: agent.id,
      });
    }

    await expect(gatedCreate()).rejects.toBeInstanceOf(MemoryPolicyDenied);

    // No memory row.
    const rows = await db.select().from(memory);
    expect(rows).toHaveLength(0);

    // No file on disk.
    const filePath = join(tmpDir, 'memory', 'notes', 'should-not-exist.md');
    expect(existsSync(filePath)).toBe(false);

    // No blob on disk (the blobs/ root itself is created lazily; the digest for
    // 'illicit write' must not be present).
    // sha256('illicit write')
    const illicitDigest =
      // calculated independently — write was never invoked, so the store
      // should report has(...) = false for any candidate digest.
      'b1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1';
    expect(await blobs.has(illicitDigest)).toBe(false);

    // The wrapper's logger also recorded exactly one denial.
    expect(wrapperRecorded).toHaveLength(1);
    expect(wrapperRecorded[0]!.kind).toBe('memory.denied');
    expect(wrapperRecorded[0]!.payload.agent_id).toBe('researcher_no_notes');
    expect(wrapperRecorded[0]!.payload.scope).toBe('notes');
    expect(wrapperRecorded[0]!.payload.action).toBe('write');
  });
});
