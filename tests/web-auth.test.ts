import { describe, expect, it } from 'vitest';

import { decideAuth, hostnameFromHostHeader } from '../web/lib/auth';

describe('web/lib/auth decideAuth', () => {
  it('allows loopback hosts without auth', () => {
    for (const host of ['127.0.0.1', '::1', 'localhost']) {
      const decision = decideAuth({ host, authorization: null, token: undefined });
      expect(decision.kind).toBe('allow');
    }
  });

  it('returns 500 when bound to non-loopback and token is missing', () => {
    const decision = decideAuth({
      host: '0.0.0.0',
      authorization: 'Bearer whatever',
      token: undefined,
    });
    expect(decision.kind).toBe('server-misconfigured');
    if (decision.kind === 'server-misconfigured') {
      expect(decision.status).toBe(500);
      expect(decision.message).toMatch(/AGENT_OS_DASHBOARD_TOKEN/);
    }
  });

  it('returns 500 when token is an empty string', () => {
    const decision = decideAuth({
      host: '192.168.1.10',
      authorization: 'Bearer x',
      token: '',
    });
    expect(decision.kind).toBe('server-misconfigured');
  });

  it('rejects requests with the wrong bearer token', () => {
    const decision = decideAuth({
      host: '0.0.0.0',
      authorization: 'Bearer nope',
      token: 'secret',
    });
    expect(decision.kind).toBe('unauthorized');
    if (decision.kind === 'unauthorized') {
      expect(decision.status).toBe(401);
      expect(decision.wwwAuthenticate).toMatch(/Bearer realm=/);
    }
  });

  it('rejects requests with no Authorization header', () => {
    const decision = decideAuth({
      host: 'example.com',
      authorization: null,
      token: 'secret',
    });
    expect(decision.kind).toBe('unauthorized');
  });

  it('allows requests with the correct bearer token', () => {
    const decision = decideAuth({
      host: 'example.com',
      authorization: 'Bearer secret',
      token: 'secret',
    });
    expect(decision.kind).toBe('allow');
  });
});

describe('hostnameFromHostHeader', () => {
  it('strips the port from an IPv4 host header', () => {
    expect(hostnameFromHostHeader('127.0.0.1:3030')).toBe('127.0.0.1');
  });

  it('returns the bare hostname when no port is present', () => {
    expect(hostnameFromHostHeader('localhost')).toBe('localhost');
  });

  it('handles bracketed IPv6 hosts', () => {
    expect(hostnameFromHostHeader('[::1]:3030')).toBe('::1');
  });

  it('returns empty string for null/undefined headers', () => {
    expect(hostnameFromHostHeader(null)).toBe('');
    expect(hostnameFromHostHeader(undefined)).toBe('');
  });
});
