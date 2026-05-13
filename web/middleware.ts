import { NextResponse, type NextRequest } from 'next/server';

import { decideAuth, hostnameFromHostHeader } from './lib/auth';

/**
 * Edge middleware enforcing the Phase 15 dashboard auth policy. The decision
 * logic lives in `./lib/auth` so it can be unit-tested without Next's runtime.
 */
export function middleware(req: NextRequest): NextResponse {
  const hostHeader = req.headers.get('host');
  const host = hostnameFromHostHeader(hostHeader);

  const decision = decideAuth({
    host,
    authorization: req.headers.get('authorization'),
    token: process.env.AGENT_OS_DASHBOARD_TOKEN,
  });

  if (decision.kind === 'allow') {
    return NextResponse.next();
  }

  if (decision.kind === 'server-misconfigured') {
    return new NextResponse(decision.message, { status: decision.status });
  }

  return new NextResponse(decision.message, {
    status: decision.status,
    headers: { 'WWW-Authenticate': decision.wwwAuthenticate },
  });
}

export const config = { matcher: ['/((?!_next/|favicon.ico).*)'] };
