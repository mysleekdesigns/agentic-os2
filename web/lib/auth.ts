/**
 * Pure dashboard auth decision function. Extracted from `middleware.ts` so it
 * can be unit-tested without Next's `NextRequest`/`NextResponse` runtime.
 *
 * Policy (PRD §3 Phase 15 — bundle C):
 *  - If the request arrived at a loopback bind (127.0.0.1 / ::1 / localhost),
 *    allow without auth.
 *  - Otherwise require a bearer token matching `AGENT_OS_DASHBOARD_TOKEN`. If
 *    the env var is missing on the server, return 500 (mis-configuration).
 *  - Wrong / missing bearer → 401 with `WWW-Authenticate: Bearer`.
 */

export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '::1', 'localhost']);

export type AuthDecision =
  | { kind: 'allow' }
  | { kind: 'server-misconfigured'; status: 500; message: string }
  | { kind: 'unauthorized'; status: 401; message: string; wwwAuthenticate: string };

export interface AuthInput {
  /** The hostname (no port) from the `Host` request header. */
  host: string;
  /** The raw `Authorization` header value, or null/undefined when absent. */
  authorization: string | null | undefined;
  /** Server-side configured token; pass `process.env.AGENT_OS_DASHBOARD_TOKEN`. */
  token: string | null | undefined;
}

/**
 * Strip the optional `:port` suffix from a Host header. We use this in the
 * middleware before passing the host into `decideAuth`.
 */
export function hostnameFromHostHeader(hostHeader: string | null | undefined): string {
  if (typeof hostHeader !== 'string') return '';
  // IPv6 hosts arrive as `[::1]:3030` — pull the bracketed segment if present.
  if (hostHeader.startsWith('[')) {
    const end = hostHeader.indexOf(']');
    if (end > 0) return hostHeader.slice(1, end);
  }
  const colon = hostHeader.indexOf(':');
  return colon === -1 ? hostHeader : hostHeader.slice(0, colon);
}

export function decideAuth(input: AuthInput): AuthDecision {
  const host = input.host;
  if (LOOPBACK_HOSTS.has(host)) {
    return { kind: 'allow' };
  }

  const token = input.token;
  if (typeof token !== 'string' || token.length === 0) {
    return {
      kind: 'server-misconfigured',
      status: 500,
      message: 'AGENT_OS_DASHBOARD_TOKEN not set on server',
    };
  }

  const auth = typeof input.authorization === 'string' ? input.authorization : '';
  const expected = `Bearer ${token}`;
  if (auth !== expected) {
    return {
      kind: 'unauthorized',
      status: 401,
      message: 'unauthorized',
      wwwAuthenticate: 'Bearer realm="agent-os-dashboard"',
    };
  }
  return { kind: 'allow' };
}
