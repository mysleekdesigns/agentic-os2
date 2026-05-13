import Link from 'next/link';
import { desc } from 'drizzle-orm';

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
import { formatDate, statusVariant, truncate } from '@/lib/format';

import { evalResults } from '@agent-os/core/storage/schema.js';

export const dynamic = 'force-dynamic';

interface FixtureGroup {
  fixtureId: string;
  total: number;
  passed: number;
  failed: number;
  lastCreatedAt: Date | null;
  rows: Array<typeof evalResults.$inferSelect>;
}

export default function EvalsPage() {
  let rows: Array<typeof evalResults.$inferSelect> = [];
  let dbError: string | null = null;

  try {
    const db = getDb();
    rows = db.select().from(evalResults).orderBy(desc(evalResults.createdAt)).limit(500).all();
  } catch (err) {
    dbError = (err as Error).message;
  }

  if (dbError) {
    return (
      <main className="mx-auto max-w-6xl space-y-4 p-6">
        <h1 className="text-2xl font-semibold">Evals</h1>
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

  if (rows.length === 0) {
    return (
      <main className="mx-auto max-w-6xl space-y-4 p-6">
        <h1 className="text-2xl font-semibold">Evals</h1>
        <Card>
          <CardHeader>
            <CardTitle>No eval runs</CardTitle>
            <CardDescription>
              Run <code className="font-mono text-xs">agent-os eval run</code> to generate reports.
            </CardDescription>
          </CardHeader>
        </Card>
      </main>
    );
  }

  // Group by fixtureId for a "per fixture" rollup. The detail per result is
  // expandable below.
  const groups = new Map<string, FixtureGroup>();
  for (const r of rows) {
    const existing = groups.get(r.fixtureId) ?? {
      fixtureId: r.fixtureId,
      total: 0,
      passed: 0,
      failed: 0,
      lastCreatedAt: null,
      rows: [],
    };
    existing.total += 1;
    if (r.passed) existing.passed += 1;
    else existing.failed += 1;
    if (!existing.lastCreatedAt || (r.createdAt && r.createdAt > existing.lastCreatedAt)) {
      existing.lastCreatedAt = r.createdAt;
    }
    existing.rows.push(r);
    groups.set(r.fixtureId, existing);
  }

  const summaries = [...groups.values()].sort((a, b) => {
    const at = a.lastCreatedAt?.getTime() ?? 0;
    const bt = b.lastCreatedAt?.getTime() ?? 0;
    return bt - at;
  });

  return (
    <main className="mx-auto max-w-6xl space-y-4 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Evals</h1>
        <p className="text-sm text-slate-500">
          Results from <code className="font-mono text-xs">agent-os eval run</code>. Each row
          aggregates all stored results for a fixture; expand for per-result detail.
        </p>
      </div>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fixture</TableHead>
                <TableHead>Pass rate</TableHead>
                <TableHead>Total</TableHead>
                <TableHead>Passed</TableHead>
                <TableHead>Failed</TableHead>
                <TableHead>Last run at</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {summaries.map((g) => {
                const rate = g.total === 0 ? 0 : Math.round((g.passed / g.total) * 100);
                return (
                  <TableRow key={g.fixtureId}>
                    <TableCell colSpan={6} className="p-0">
                      <details className="group">
                        <summary className="grid cursor-pointer grid-cols-6 items-center gap-2 px-4 py-2 text-sm hover:bg-slate-50 dark:hover:bg-slate-800">
                          <span className="font-mono text-xs">{truncate(g.fixtureId, 60)}</span>
                          <span>
                            <Badge variant={rate === 100 ? 'ok' : rate === 0 ? 'fail' : 'warn'}>
                              {rate}%
                            </Badge>
                          </span>
                          <span className="text-xs">{g.total}</span>
                          <span className="text-xs text-emerald-600">{g.passed}</span>
                          <span className="text-xs text-rose-600">{g.failed}</span>
                          <span className="text-xs">{formatDate(g.lastCreatedAt)}</span>
                        </summary>
                        <div className="border-t border-slate-200 bg-slate-50 px-4 py-2 dark:border-slate-800 dark:bg-slate-900/40">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>Result ID</TableHead>
                                <TableHead>Run</TableHead>
                                <TableHead>Score</TableHead>
                                <TableHead>Verdict</TableHead>
                                <TableHead>Created</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {g.rows.map((r) => (
                                <TableRow key={r.id}>
                                  <TableCell className="font-mono text-xs">
                                    {truncate(r.id, 24)}
                                  </TableCell>
                                  <TableCell className="font-mono text-xs">
                                    {r.runId ? (
                                      <Link
                                        href={`/runs/${r.runId}`}
                                        className="underline-offset-2 hover:underline"
                                      >
                                        {truncate(r.runId, 16)}
                                      </Link>
                                    ) : (
                                      '—'
                                    )}
                                  </TableCell>
                                  <TableCell className="text-xs">{r.score}</TableCell>
                                  <TableCell>
                                    <Badge variant={statusVariant(r.passed ? 'passed' : 'failed')}>
                                      {r.passed ? 'pass' : 'fail'}
                                    </Badge>
                                  </TableCell>
                                  <TableCell className="text-xs">
                                    {formatDate(r.createdAt)}
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      </details>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </main>
  );
}
