import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type AgentOsDb } from '../../src/storage/db.js';
import { tryLoadVec } from '../../src/storage/vec.js';
import { detectCapabilities } from '../../src/storage/capabilities.js';

describe('sqlite-vec optional loader', () => {
  let db: AgentOsDb;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  afterEach(() => {
    db.$sqlite.close();
  });

  it('returns a well-formed VecLoadResult', async () => {
    const result = await tryLoadVec(db);
    expect(typeof result.available).toBe('boolean');
    if (!result.available) {
      expect(typeof result.reason).toBe('string');
      expect(result.reason!.length).toBeGreaterThan(0);
    }
  });

  it('detectCapabilities surfaces the same outcome', async () => {
    const caps = await detectCapabilities(db);
    expect(typeof caps.semantic_search).toBe('boolean');
    if (!caps.semantic_search) {
      expect(typeof caps.vec_reason).toBe('string');
    }
  });

  it('never throws on a fresh :memory: connection', async () => {
    await expect(tryLoadVec(db)).resolves.toBeDefined();
  });

  it('if sqlite-vec is available, vec_version() returns a non-empty string', async () => {
    const result = await tryLoadVec(db);
    if (!result.available) {
      // Skip — environment without the extension.
      return;
    }
    const row = db.$sqlite.prepare('SELECT vec_version() AS v').get() as {
      v?: string;
    };
    expect(row?.v).toBeTruthy();
  });
});
