import { asc, desc } from 'drizzle-orm';

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

import { approvals, toolCalls } from '@agent-os/core/storage/schema.js';
import { eq } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

interface ApprovalRow {
  id: string;
  action: string;
  status: string;
  runId: string | null;
  stepId: string | null;
  requestedBy: string;
  requestedAt: Date | null;
  decidedBy: string | null;
  decidedAt: Date | null;
  reason: string | null;
  tool: string | null;
  risk: string | null;
}

export default function ApprovalsPage() {
  let pending: ApprovalRow[] = [];
  let decided: ApprovalRow[] = [];
  let dbError: string | null = null;

  try {
    const db = getDb();
    // Pending first (oldest first — FIFO queue).
    pending = db
      .select({
        id: approvals.id,
        action: approvals.action,
        status: approvals.status,
        runId: approvals.runId,
        stepId: approvals.stepId,
        requestedBy: approvals.requestedBy,
        requestedAt: approvals.requestedAt,
        decidedBy: approvals.decidedBy,
        decidedAt: approvals.decidedAt,
        reason: approvals.reason,
        tool: toolCalls.tool,
        risk: toolCalls.risk,
      })
      .from(approvals)
      .leftJoin(toolCalls, eq(toolCalls.stepId, approvals.stepId))
      .where(eq(approvals.status, 'pending'))
      .orderBy(asc(approvals.requestedAt))
      .all() as ApprovalRow[];

    // Decided rows — last 100, most recently decided first.
    const all = db
      .select({
        id: approvals.id,
        action: approvals.action,
        status: approvals.status,
        runId: approvals.runId,
        stepId: approvals.stepId,
        requestedBy: approvals.requestedBy,
        requestedAt: approvals.requestedAt,
        decidedBy: approvals.decidedBy,
        decidedAt: approvals.decidedAt,
        reason: approvals.reason,
        tool: toolCalls.tool,
        risk: toolCalls.risk,
      })
      .from(approvals)
      .leftJoin(toolCalls, eq(toolCalls.stepId, approvals.stepId))
      .orderBy(desc(approvals.decidedAt))
      .limit(200)
      .all() as ApprovalRow[];

    decided = all.filter((r) => r.status !== 'pending').slice(0, 100);
  } catch (err) {
    dbError = (err as Error).message;
  }

  if (dbError) {
    return (
      <main className="mx-auto max-w-6xl space-y-4 p-6">
        <h1 className="text-2xl font-semibold">Approvals</h1>
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

  const isEmpty = pending.length === 0 && decided.length === 0;

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Approvals</h1>
        <p className="text-sm text-slate-500">
          Read-only view. Approve or reject from the CLI:{' '}
          <code className="font-mono text-xs">agent-os approvals approve &lt;id&gt;</code>.
        </p>
      </div>

      {isEmpty ? (
        <Card>
          <CardHeader>
            <CardTitle>No approval requests</CardTitle>
            <CardDescription>
              Approvals appear here when an agent requests permission for a higher-risk tool call.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {pending.length > 0 ? (
        <ApprovalsTable title="Pending" rows={pending} timeColumn="requested" />
      ) : null}

      {decided.length > 0 ? (
        <ApprovalsTable title="Recently decided" rows={decided} timeColumn="decided" />
      ) : null}
    </main>
  );
}

function ApprovalsTable({
  title,
  rows,
  timeColumn,
}: {
  title: string;
  rows: ApprovalRow[];
  timeColumn: 'requested' | 'decided';
}) {
  return (
    <section className="space-y-2">
      <h2 className="text-lg font-semibold">{title}</h2>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>Tool</TableHead>
                <TableHead>Risk</TableHead>
                <TableHead>Decision</TableHead>
                <TableHead>Decided by</TableHead>
                <TableHead>Requested at</TableHead>
                {timeColumn === 'decided' ? <TableHead>Decided at</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">{truncate(r.id, 16)}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {r.tool ?? truncate(r.action, 32)}
                  </TableCell>
                  <TableCell>
                    {r.risk ? <Badge variant="neutral">{r.risk}</Badge> : <span>—</span>}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
                  </TableCell>
                  <TableCell className="text-xs">{r.decidedBy ?? '—'}</TableCell>
                  <TableCell className="text-xs">{formatDate(r.requestedAt)}</TableCell>
                  {timeColumn === 'decided' ? (
                    <TableCell className="text-xs">{formatDate(r.decidedAt)}</TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </section>
  );
}
