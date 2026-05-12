import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { openDatabase, type AgentOsDb } from '../../../src/storage/db.js';
import { runMigrations } from '../../../src/storage/migrate.js';
import { agents } from '../../../src/storage/schema.js';
import { syncRegistry } from '../../../src/core/agents/registry.js';
import type { AgentDefinition } from '../../../src/core/agents/loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MIGRATIONS_DIR = resolve(__dirname, '..', '..', '..', 'drizzle', 'migrations');

function makeDef(overrides: Partial<AgentDefinition['frontmatter']> & { hash?: string } = {}) {
  const fm = {
    id: overrides.id ?? 'research_agent',
    name: overrides.name ?? 'Research Agent',
    version: overrides.version ?? 1,
    role: overrides.role ?? 'role',
    provider: overrides.provider ?? 'claude_code_local',
    tools: overrides.tools ?? { allowed: [], approval_required: [] },
    permissions: overrides.permissions ?? {
      network: 'allow',
      file_read: 'allow',
      file_write: 'allow',
      shell: 'allow',
    },
    memory: overrides.memory ?? { read: [], write: [] },
  } as AgentDefinition['frontmatter'];
  return {
    frontmatter: fm,
    body: '# body\n',
    path: `/tmp/agents/${fm.id}.md`,
    hash: overrides.hash ?? `${fm.id}_hash_v${fm.version}`.padEnd(64, '0'),
  } satisfies AgentDefinition;
}

describe('syncRegistry', () => {
  let db: AgentOsDb;

  beforeEach(async () => {
    db = openDatabase(':memory:');
    await runMigrations(db, { migrationsDir: MIGRATIONS_DIR, log: () => {} });
  });

  afterEach(() => {
    db.$sqlite.close();
  });

  it('inserts new agents', async () => {
    const result = await syncRegistry(db, [makeDef({ id: 'a' }), makeDef({ id: 'b' })]);
    expect(result).toEqual({ inserted: 2, updated: 0, unchanged: 0 });

    const rows = await db.select().from(agents);
    expect(rows).toHaveLength(2);
    const a = rows.find((r) => r.id === 'a');
    expect(a?.version).toBe('1');
    expect(a?.definitionPath).toBe('/tmp/agents/a.md');
    expect(a?.createdAt).toBeInstanceOf(Date);
  });

  it('reports unchanged when hash matches on second sync', async () => {
    const defs = [makeDef({ id: 'a' })];
    await syncRegistry(db, defs);
    const second = await syncRegistry(db, defs);
    expect(second).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
  });

  it('updates hash/version/path when hash changes, keeping created_at', async () => {
    const original = makeDef({ id: 'a', version: 1, hash: 'h1'.padEnd(64, '0') });
    await syncRegistry(db, [original]);
    const before = (await db.select().from(agents).where(eq(agents.id, 'a')))[0]!;

    const next: AgentDefinition = {
      ...original,
      frontmatter: { ...original.frontmatter, version: 2 },
      path: '/tmp/agents/a-renamed.md',
      hash: 'h2'.padEnd(64, '0'),
    };
    const result = await syncRegistry(db, [next]);
    expect(result).toEqual({ inserted: 0, updated: 1, unchanged: 0 });

    const after = (await db.select().from(agents).where(eq(agents.id, 'a')))[0]!;
    expect(after.version).toBe('2');
    expect(after.hash).toBe('h2'.padEnd(64, '0'));
    expect(after.definitionPath).toBe('/tmp/agents/a-renamed.md');
    expect(after.createdAt?.getTime()).toBe(before.createdAt?.getTime());
  });

  it('handles a mixed batch in a single transaction', async () => {
    await syncRegistry(db, [
      makeDef({ id: 'unchanged' }),
      makeDef({ id: 'will-update', hash: 'old'.padEnd(64, '0') }),
    ]);

    const result = await syncRegistry(db, [
      makeDef({ id: 'unchanged' }),
      makeDef({ id: 'will-update', hash: 'new'.padEnd(64, '0') }),
      makeDef({ id: 'fresh' }),
    ]);
    expect(result).toEqual({ inserted: 1, updated: 1, unchanged: 1 });

    const rows = await db.select().from(agents);
    expect(rows).toHaveLength(3);
  });
});
