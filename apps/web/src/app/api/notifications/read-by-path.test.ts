import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mocks ───────────────────────────────────────────────────────

const mockMarkReadByActionPath = vi.fn();
vi.mock('@balo/db', () => ({
  userNotificationsRepository: {
    markReadByActionPath: (...args: unknown[]) => mockMarkReadByActionPath(...args),
  },
}));

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth', () => ({
  getCurrentUser: () => mockGetCurrentUser(),
}));

const mockLogError = vi.fn();
vi.mock('@/lib/logging', () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: (...args: unknown[]) => mockLogError(...args),
  },
}));

import { POST } from './read-by-path/route';

// ── Helpers ─────────────────────────────────────────────────────

function makeRequest(body: unknown, raw = false, contentType = 'application/json'): NextRequest {
  return new NextRequest(new URL('http://localhost:3000/api/notifications/read-by-path'), {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: raw ? String(body) : JSON.stringify(body),
  });
}

// ── Tests ───────────────────────────────────────────────────────

describe('POST /api/notifications/read-by-path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockMarkReadByActionPath.mockResolvedValue(['n1', 'n2']);
  });

  it('returns 401 when no session', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    const res = await POST(makeRequest({ path: '/projects/p1' }));

    expect(res.status).toBe(401);
    expect(mockMarkReadByActionPath).not.toHaveBeenCalled();
  });

  it('marks the path read and returns the updated ids', async () => {
    const res = await POST(makeRequest({ path: '/projects/p1' }));

    expect(res.status).toBe(200);
    expect(mockMarkReadByActionPath).toHaveBeenCalledWith('user-1', '/projects/p1');
    expect(await res.json()).toEqual({ readIds: ['n1', 'n2'] });
  });

  it.each([
    '/projects',
    '/experts',
    '/settings/billing',
    '/meetings/m1/call',
    '/projects/p1/files',
    '/cases/',
  ])('returns an empty readIds without touching the repository for %s', async (path) => {
    const res = await POST(makeRequest({ path }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ readIds: [] });
    expect(mockMarkReadByActionPath).not.toHaveBeenCalled();
  });

  it('skips with 200 and writes nothing under impersonation', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', isImpersonating: true });

    const res = await POST(makeRequest({ path: '/projects/p1' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: true });
    expect(mockMarkReadByActionPath).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing path', {}],
    ['a non-string path', { path: 42 }],
    ['a path without a leading slash', { path: 'projects/p1' }],
    ['a path containing a query', { path: '/projects/p1?from=x' }],
    ['a path containing a fragment', { path: '/projects/p1#top' }],
    ['a 501-character path', { path: `/${'a'.repeat(500)}` }],
    ['a path containing a NUL', { path: '/p\u0000x' }],
    ['a path containing a newline', { path: '/p\nx' }],
    ['a path containing a DEL', { path: '/p\u007Fx' }],
  ])('returns 400 for %s', async (_label, body) => {
    const res = await POST(makeRequest(body));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid request body' });
    expect(mockMarkReadByActionPath).not.toHaveBeenCalled();
  });

  it('returns 415 for a non-JSON content type, after the auth and impersonation checks', async () => {
    const res = await POST(makeRequest({ path: '/projects/p1' }, false, 'text/plain'));

    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: 'Unsupported media type' });
    expect(mockMarkReadByActionPath).not.toHaveBeenCalled();

    mockGetCurrentUser.mockResolvedValue(null);
    expect((await POST(makeRequest({ path: '/projects/p1' }, false, 'text/plain'))).status).toBe(
      401
    );

    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', isImpersonating: true });
    expect((await POST(makeRequest({ path: '/projects/p1' }, false, 'text/plain'))).status).toBe(
      200
    );
  });

  it('accepts a JSON content type with a charset parameter', async () => {
    const res = await POST(
      makeRequest({ path: '/projects/p1' }, false, 'application/json; charset=utf-8')
    );

    expect(res.status).toBe(200);
  });

  it('accepts a 500-character path', async () => {
    const res = await POST(makeRequest({ path: `/${'a'.repeat(499)}` }));

    expect(res.status).toBe(200);
  });

  it('returns 400 for an unparseable body', async () => {
    const res = await POST(makeRequest('not json', true));

    expect(res.status).toBe(400);
  });

  it('returns 500 and logs with the path when the repository throws', async () => {
    mockMarkReadByActionPath.mockRejectedValue(new Error('DB down'));

    const res = await POST(makeRequest({ path: '/projects/p1' }));

    expect(res.status).toBe(500);
    expect(mockLogError).toHaveBeenCalledWith(
      'Failed to mark notifications read by path',
      expect.objectContaining({ userId: 'user-1', path: '/projects/p1', error: 'DB down' })
    );
  });
});
