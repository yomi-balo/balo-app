import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import type { IronSession } from 'iron-session';
import type { SessionData, SessionUser } from '@/lib/auth/session';
import { middleware } from './middleware';

// ── Mocks ───────────────────────────────────────────────────────

const mockGetMiddlewareSession = vi.fn();
const mockRefreshSessionIfNeeded = vi.fn();
const mockClearMiddlewareSession = vi.fn();

vi.mock('@/lib/auth/middleware-session', () => ({
  getMiddlewareSession: (...args: unknown[]) => mockGetMiddlewareSession(...args),
  refreshSessionIfNeeded: (...args: unknown[]) => mockRefreshSessionIfNeeded(...args),
  clearMiddlewareSession: (...args: unknown[]) => mockClearMiddlewareSession(...args),
}));

// ── Helpers ─────────────────────────────────────────────────────

const BASE_URL = 'http://localhost:3000';

function createRequest(path: string, method = 'GET'): NextRequest {
  return new NextRequest(new URL(path, BASE_URL), { method });
}

function mockSessionUser(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'user-123',
    email: 'test@example.com',
    firstName: 'Test',
    lastName: 'User',
    activeMode: 'client',
    onboardingCompleted: true,
    platformRole: 'user',
    companyId: 'company-1',
    companyName: 'Test Co',
    companyRole: 'owner',
    ...overrides,
  };
}

function mockSession(
  user: SessionUser | undefined,
  overrides: Partial<SessionData> = {}
): { session: Partial<IronSession<SessionData>>; response: Response } {
  return {
    session: {
      user,
      accessToken: 'at_valid',
      refreshToken: 'rt_valid',
      ...overrides,
      save: vi.fn(),
      destroy: vi.fn(),
    } as Partial<IronSession<SessionData>>,
    response: NextResponse.next(),
  };
}

function setupAuthenticatedSession(userOverrides: Partial<SessionUser> = {}): void {
  const user = mockSessionUser(userOverrides);
  mockGetMiddlewareSession.mockResolvedValue(mockSession(user));
  mockRefreshSessionIfNeeded.mockResolvedValue(null);
}

function setupUnauthenticatedSession(): void {
  mockGetMiddlewareSession.mockResolvedValue(mockSession(undefined));
  mockClearMiddlewareSession.mockResolvedValue(new Response(null, { headers: new Headers() }));
}

// ── Tests ───────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockRefreshSessionIfNeeded.mockResolvedValue(null);
  mockClearMiddlewareSession.mockResolvedValue(new Response(null, { headers: new Headers() }));
});

describe('middleware — public routes', () => {
  it('passes through / without session check', async () => {
    const res = await middleware(createRequest('/'));
    expect(res.status).toBe(200);
    expect(mockGetMiddlewareSession).not.toHaveBeenCalled();
  });

  it('passes through /experts without session check', async () => {
    const res = await middleware(createRequest('/experts'));
    expect(res.status).toBe(200);
    expect(mockGetMiddlewareSession).not.toHaveBeenCalled();
  });

  it('passes through /experts/abc-123', async () => {
    const res = await middleware(createRequest('/experts/abc-123'));
    expect(res.status).toBe(200);
  });

  it('passes through /blog/some-post', async () => {
    const res = await middleware(createRequest('/blog/some-post'));
    expect(res.status).toBe(200);
  });

  it('passes through /api/health', async () => {
    const res = await middleware(createRequest('/api/health'));
    expect(res.status).toBe(200);
  });

  it('passes through /api/auth/callback', async () => {
    const res = await middleware(createRequest('/api/auth/callback'));
    expect(res.status).toBe(200);
  });

  it('passes through /login', async () => {
    const res = await middleware(createRequest('/login'));
    expect(res.status).toBe(200);
  });

  it('always sets x-request-id on public routes', async () => {
    const res = await middleware(createRequest('/'));
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });
});

describe('middleware — unauthenticated access', () => {
  beforeEach(() => {
    setupUnauthenticatedSession();
  });

  it('redirects /dashboard to /login?returnTo=/dashboard', async () => {
    const res = await middleware(createRequest('/dashboard'));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get('location')!);
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('returnTo')).toBe('/dashboard');
  });

  it('redirects /settings/profile to /login with returnTo', async () => {
    const res = await middleware(createRequest('/settings/profile'));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get('location')!);
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('returnTo')).toBe('/settings/profile');
  });

  it('redirects /admin/users to /login with returnTo', async () => {
    const res = await middleware(createRequest('/admin/users'));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get('location')!);
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('returnTo')).toBe('/admin/users');
  });

  it('preserves query string in returnTo', async () => {
    const res = await middleware(createRequest('/dashboard?tab=billing'));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get('location')!);
    expect(location.searchParams.get('returnTo')).toBe('/dashboard?tab=billing');
  });

  it('sets x-request-id on redirect responses', async () => {
    const res = await middleware(createRequest('/dashboard'));
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });
});

describe('middleware — authenticated access', () => {
  it('passes through /dashboard for onboarded user', async () => {
    setupAuthenticatedSession();
    const res = await middleware(createRequest('/dashboard'));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('passes through /cases/123 for onboarded user', async () => {
    setupAuthenticatedSession();
    const res = await middleware(createRequest('/cases/123'));
    expect(res.status).toBe(200);
  });

  it('calls refreshSessionIfNeeded on protected routes', async () => {
    setupAuthenticatedSession();
    await middleware(createRequest('/dashboard'));
    expect(mockRefreshSessionIfNeeded).toHaveBeenCalled();
  });
});

describe('middleware — admin routes', () => {
  it('allows admin to access /admin/users', async () => {
    setupAuthenticatedSession({ platformRole: 'admin' });
    const res = await middleware(createRequest('/admin/users'));
    expect(res.status).toBe(200);
  });

  it('allows super_admin to access /admin', async () => {
    setupAuthenticatedSession({ platformRole: 'super_admin' });
    const res = await middleware(createRequest('/admin'));
    expect(res.status).toBe(200);
  });

  it('redirects non-admin to /dashboard (not /login)', async () => {
    setupAuthenticatedSession({ platformRole: 'user' });
    const res = await middleware(createRequest('/admin/users'));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get('location')!);
    expect(location.pathname).toBe('/dashboard');
  });

  it('defaults undefined platformRole to user (deny admin)', async () => {
    setupAuthenticatedSession();
    // Manually override to simulate old session without platformRole
    const user = mockSessionUser();
    const session = mockSession(user);
    (session.session as Record<string, unknown>).user = {
      ...user,
      platformRole: undefined,
    };
    mockGetMiddlewareSession.mockResolvedValue(session);

    const res = await middleware(createRequest('/admin/users'));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get('location')!);
    expect(location.pathname).toBe('/dashboard');
  });
});

describe('middleware — onboarding', () => {
  it('redirects non-onboarded user from /dashboard to /onboarding', async () => {
    setupAuthenticatedSession({ onboardingCompleted: false });
    const res = await middleware(createRequest('/dashboard'));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get('location')!);
    expect(location.pathname).toBe('/onboarding');
  });

  it('allows non-onboarded user to stay on /onboarding', async () => {
    setupAuthenticatedSession({ onboardingCompleted: false });
    const res = await middleware(createRequest('/onboarding'));
    expect(res.status).toBe(200);
  });

  it('bounces onboarded user from /onboarding to /dashboard', async () => {
    setupAuthenticatedSession({ onboardingCompleted: true });
    const res = await middleware(createRequest('/onboarding'));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get('location')!);
    expect(location.pathname).toBe('/dashboard');
  });

  it('skips onboarding check for API routes', async () => {
    setupAuthenticatedSession({ onboardingCompleted: false });
    const res = await middleware(createRequest('/api/cases'));
    // Should NOT redirect to /onboarding for API routes
    expect(res.status).toBe(200);
  });
});

describe('middleware — token refresh', () => {
  it('uses refreshed response when token refresh succeeds', async () => {
    const user = mockSessionUser();
    mockGetMiddlewareSession.mockResolvedValue(mockSession(user));

    const refreshedResponse = NextResponse.next();
    refreshedResponse.headers.set('x-refreshed', 'true');
    mockRefreshSessionIfNeeded.mockResolvedValue(refreshedResponse);

    const res = await middleware(createRequest('/dashboard'));
    expect(res.headers.get('x-refreshed')).toBe('true');
  });

  it('uses original response when token refresh returns null', async () => {
    setupAuthenticatedSession();
    mockRefreshSessionIfNeeded.mockResolvedValue(null);

    const res = await middleware(createRequest('/dashboard'));
    expect(res.status).toBe(200);
  });
});

describe('middleware — session errors', () => {
  it('redirects to /login when session decryption fails', async () => {
    mockGetMiddlewareSession.mockRejectedValue(new Error('Decryption failed'));

    const res = await middleware(createRequest('/dashboard'));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get('location')!);
    expect(location.pathname).toBe('/login');
  });

  it('still sets x-request-id on error redirects', async () => {
    mockGetMiddlewareSession.mockRejectedValue(new Error('Decryption failed'));

    const res = await middleware(createRequest('/dashboard'));
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });
});
