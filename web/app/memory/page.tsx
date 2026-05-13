import { asc, desc, like, or } from 'drizzle-orm';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { getDb } from '@/lib/db';
import { formatDate, truncate } from '@/lib/format';

import { memory } from '@agent-os/core/storage/schema.js';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ q?: string }>;
}

export default async function MemoryPage({ searchParams }: PageProps) {
  const { q } = await searchParams;
  const query = q?.trim() ?? '';

  let rows: Array<typeof memory.$inferSelect> = [];
  let dbError: string | null = null;

  try {
    const db = getDb();
    if (query) {
      const pattern = `%${query.replace(/[%_]/g, (m) => `\\${m}`)}%`;
      rows = db
        .select()
        .from(memory)
        .where(or(like(memory.key, pattern), like(memory.valueRef, pattern)))
        .orderBy(asc(memory.scope), asc(memory.key))
        .limit(500)
        .all();
    } else {
      rows = db
        .select()
        .from(memory)
        .orderBy(asc(memory.scope), desc(memory.updatedAt))
        .limit(500)
        .all();
    }
  } catch (err) {
    dbError = (err as Error).message;
  }

  if (dbError) {
    return (
      <main className="mx-auto max-w-6xl space-y-4 p-6">
        <h1 className="text-2xl font-semibold">Memory</h1>
        <Card>
          <CardHeader>
            <CardTitle>Database not found</CardTitle>
            <CardDescription>
              Run <code className="font-mono text-xs">agent-os init</code> from the workspace root.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-slate-500">{dbError}</p>
          </CardContent>
        </Card>
      </main>
    );
  }

  // Group rows by scope (stable preserved-order grouping).
  const byScope = new Map<string, Array<typeof memory.$inferSelect>>();
  for (const row of rows) {
    const list = byScope.get(row.scope) ?? [];
    list.push(row);
    byScope.set(row.scope, list);
  }

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Memory</h1>
          <p className="text-sm text-slate-500">
            Entries written by agents via the memory tools. Read-only.
          </p>
        </div>
        <form method="GET" className="flex gap-2">
          <input
            type="search"
            name="q"
            defaultValue={query}
            placeholder="Search keys / values"
            className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
          />
          <button
            type="submit"
            className="rounded border border-slate-300 bg-slate-100 px-3 py-1.5 text-sm hover:bg-slate-200 dark:border-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700"
          >
            Search
          </button>
        </form>
      </div>

      {rows.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{query ? 'No matches' : 'No memory entries'}</CardTitle>
            <CardDescription>
              {query ? (
                <>
                  No entries match <code className="font-mono text-xs">{query}</code>.
                </>
              ) : (
                <>
                  Agents write to memory automatically; see{' '}
                  <code className="font-mono text-xs">docs/memory.md</code>.
                </>
              )}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="space-y-6">
          {[...byScope.entries()].map(([scope, scopeRows]) => (
            <section key={scope} className="space-y-2">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                {scope} <span className="font-normal text-slate-400">({scopeRows.length})</span>
              </h2>
              <Card>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Key</TableHead>
                        <TableHead>Agent</TableHead>
                        <TableHead>Updated</TableHead>
                        <TableHead>Rev</TableHead>
                        <TableHead>State</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {scopeRows.map((r) => (
                        <TableRow key={r.id}>
                          <TableCell className="font-mono text-xs">{truncate(r.key, 80)}</TableCell>
                          <TableCell className="text-xs">{r.agentId ?? '—'}</TableCell>
                          <TableCell className="text-xs">{formatDate(r.updatedAt)}</TableCell>
                          <TableCell className="text-xs">{r.revision}</TableCell>
                          <TableCell>
                            {r.deletedAt ? (
                              <Badge variant="fail">tombstoned</Badge>
                            ) : (
                              <Badge variant="ok">live</Badge>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
