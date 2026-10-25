import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mocks ───────────────────────────────────────────────────────

const mockAdvance = vi.fn();
vi.mock('@balo/db', () => ({
  usersRepository: {
    advanceNotificationsSeenThrough: (...args: unknown[]) => mockAdvance(...args),
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

import { POST } from './seen/route';

// ── Helpers ─────────────────────────────────────────────────────

function makeRequest(body: unknown, raw = false, contentType = 'application/json'): NextRequest {
  return new NextRequest(new URL('http://localhost:3000/api/notifications/seen'), {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: raw ? String(body) : JSON.stringify(body),
  });
}

const THROUGH = '2026-03-22T10:00:00.000Z';

// ── Tests ───────────────────────────────────────────────────────

describe('POST /api/notifications/seen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAdvance.mockResolvedValue(new Date(THROUGH));
  });

  it('returns 401 when no session', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    const res = await POST(makeRequest({ through: THROUGH }));

    expect(res.status).toBe(401);
    expect(mockAdvance).not.toHaveBeenCalled();
  });

  it('advances the cursor and returns the stored value as ISO', async () => {
    const res = await POST(makeRequest({ through: THROUGH }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockAdvance).toHaveBeenCalledWith('user-1', new Date(THROUGH));
    expect(body).toEqual({ lastSeenAt: THROUGH });
  });

  it('returns lastSeenAt null when no live row matched', async () => {
    mockAdvance.mockResolvedValue(null);

    const res = await POST(makeRequest({ through: THROUGH }));

    expect(await res.json()).toEqual({ lastSeenAt: null });
  });

  it('skips with 200 and writes nothing under impersonation', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', isImpersonating: true });

    const res = await POST(makeRequest({ through: THROUGH }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: true });
    expect(mockAdvance).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing through', {}],
    ['a non-ISO through', { through: 'yesterday' }],
    ['a non-string through', { through: 12345 }],
  ])('returns 400 for %s', async (_label, body) => {
    const res = await POST(makeRequest(body));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid request body' });
    expect(mockAdvance).not.toHaveBeenCalled();
  });

  it('returns 415 for a non-JSON content type, after the auth and impersonation checks', async () => {
    const res = await POST(makeRequest({ through: THROUGH }, false, 'text/plain'));

    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: 'Unsupported media type' });
    expect(mockAdvance).not.toHaveBeenCalled();

    mockGetCurrentUser.mockResolvedValue(null);
    expect((await POST(makeRequest({ through: THROUGH }, false, 'text/plain'))).status).toBe(401);

    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', isImpersonating: true });
    expect((await POST(makeRequest({ through: THROUGH }, false, 'text/plain'))).status).toBe(200);
  });

  it('accepts a JSON content type with a charset parameter', async () => {
    const res = await POST(
      makeRequest({ through: THROUGH }, false, 'application/json; charset=utf-8')
    );

    expect(res.status).toBe(200);
  });

  it('returns 400 for an unparseable body', async () => {
    const res = await POST(makeRequest('not json', true));

    expect(res.status).toBe(400);
  });

  it('returns 500 and logs when the repository throws', async () => {
    mockAdvance.mockRejectedValue(new Error('DB down'));

    const res = await POST(makeRequest({ through: THROUGH }));

    expect(res.status).toBe(500);
    expect(mockLogError).toHaveBeenCalledWith(
      'Failed to advance notifications seen cursor',
      expect.objectContaining({ userId: 'user-1', error: 'DB down' })
    );
  });
});
