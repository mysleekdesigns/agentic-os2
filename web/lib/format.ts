/**
 * Small presentation helpers shared by the dashboard pages.
 *
 * All functions are pure and safe to import into Server Components.
 */

export type StatusTone = 'ok' | 'fail' | 'warn' | 'neutral';

export function formatDate(d: Date | number | string | null | undefined): string {
  if (d === null || d === undefined) return '—';
  let date: Date;
  if (d instanceof Date) date = d;
  else if (typeof d === 'number') {
    // Drizzle's `mode: 'timestamp'` stores seconds, but Date() consumes ms.
    // Numbers < 1e12 are treated as epoch seconds, larger as ms (covers both).
    date = new Date(d < 1e12 ? d * 1000 : d);
  } else date = new Date(d);
  if (Number.isNaN(date.getTime())) return '—';
  return date
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, 'Z');
}

export function truncate(s: string | null | undefined, n: number): string {
  if (!s) return '';
  if (s.length <= n) return s;
  return `${s.slice(0, Math.max(0, n - 1))}…`;
}

export function statusVariant(status: string | null | undefined): StatusTone {
  if (!status) return 'neutral';
  const s = status.toLowerCase();
  if (
    s === 'succeeded' ||
    s === 'success' ||
    s === 'ok' ||
    s === 'approved' ||
    s === 'passed' ||
    s === 'pass'
  )
    return 'ok';
  if (s === 'failed' || s === 'rejected' || s === 'error' || s === 'expired' || s === 'fail')
    return 'fail';
  if (s === 'pending' || s === 'running' || s === 'warn' || s === 'skipped') return 'warn';
  return 'neutral';
}

export function formatDuration(
  startedAt: Date | number | null | undefined,
  endedAt: Date | number | null | undefined,
): string {
  if (!startedAt) return '—';
  const start =
    startedAt instanceof Date
      ? startedAt.getTime()
      : startedAt < 1e12
        ? startedAt * 1000
        : startedAt;
  if (!endedAt) return 'in progress';
  const end =
    endedAt instanceof Date ? endedAt.getTime() : endedAt < 1e12 ? endedAt * 1000 : endedAt;
  const ms = end - start;
  if (ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m${rem}s`;
}
