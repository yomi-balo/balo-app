import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mocks ───────────────────────────────────────────────────────

const mockFindForSessionSync = vi.fn();
vi.mock('@balo/db', () => ({
  usersRepository: {
    findForSessionSync: (...args: unknown[]) => mockFindForSessionSync(...args),
  },
}));

const mockGetSession = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getSession: () => mockGetSession(),
}));

vi.mock('@/lib/logging', () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { GET } from './route';

// ── Helpers ─────────────────────────────────────────────────────

const BASE_URL = 'http://localhost:3000';

function makeRequest(queryString = ''): NextRequest {
  const url = `${BASE_URL}/api/auth/session-sync${queryString ? `?${queryString}` : ''}`;
  return new NextRequest(new URL(url));
}

function createMockSession(userOverrides: Record<string, unknown> = {}) {
  return {
    user: {
      id: 'user-1',
      email: 'test@example.com',
      firstName: 'Test',
      lastName: 'User',
      activeMode: 'client',
      platformRole: 'user',
      onboardingCompleted: true,
      companyId: 'company-1',
      companyName: 'Test Company',
      companyRole: 'owner',
      expertProfileId: undefined,
      ...userOverrides,
    },
    save: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn(),
  };
}

function createDbUser(overrides: Record<string, unknown> = {}) {
  return {
    status: 'active',
    activeMode: 'client',
    platformRole: 'user',
    onboardingCompleted: true,
    deletedAt: null,
    expertProfileId: null,
    ...overrides,
  };
}

function getRedirectLocation(response: Response): string {
  return (
    new URL(response.headers.get('Location')!).pathname +
    new URL(response.headers.get('Location')!).search
  );
}

// ── Tests ───────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/auth/session-sync', () => {
  describe('no session', () => {
    it('redirects to /login when session has no user', async () => {
      mockGetSession.mockResolvedValue({ user: undefined, save: vi.fn(), destroy: vi.fn() });

      const response = await GET(makeRequest('returnTo=/dashboard'));

      expect(response.status).toBe(307);
      expect(getRedirectLocation(response)).toBe('/login');
    });

    it('redirects to /login when session is null-ish', async () => {
      mockGetSession.mockResolvedValue({ save: vi.fn(), destroy: vi.fn() });

      const response = await GET(makeRequest());

      expect(response.status).toBe(307);
      expect(getRedirectLocation(response)).toBe('/login');
    });
  });

  describe('user not found in DB', () => {
    it('destroys session and redirects to /login with error', async () => {
      const session = createMockSession();
      mockGetSession.mockResolvedValue(session);
      mockFindForSessionSync.mockResolvedValue(undefined);

      const response = await GET(makeRequest('returnTo=/dashboard'));

      expect(session.destroy).toHaveBeenCalled();
      expect(response.status).toBe(307);
      expect(getRedirectLocation(response)).toBe('/login?error=account_deleted');
    });
  });

  describe('deleted user', () => {
    it('destroys session and redirects to /login with account_deleted error', async () => {
      const session = createMockSession();
      mockGetSession.mockResolvedValue(session);
      mockFindForSessionSync.mockResolvedValue(createDbUser({ deletedAt: new Date('2025-06-01') }));

      const response = await GET(makeRequest('returnTo=/settings'));

      expect(session.destroy).toHaveBeenCalled();
      expect(response.status).toBe(307);
      expect(getRedirectLocation(response)).toBe('/login?error=account_deleted');
    });
  });

  describe('suspended user', () => {
    it('destroys session and redirects to /login with account_suspended error', async () => {
      const session = createMockSession();
      mockGetSession.mockResolvedValue(session);
      mockFindForSessionSync.mockResolvedValue(createDbUser({ status: 'suspended' }));

      const response = await GET(makeRequest('returnTo=/dashboard'));

      expect(session.destroy).toHaveBeenCalled();
      expect(response.status).toBe(307);
      expect(getRedirectLocation(response)).toBe('/login?error=account_suspended');
    });

    it('destroys session for inactive users too', async () => {
      const session = createMockSession();
      mockGetSession.mockResolvedValue(session);
      mockFindForSessionSync.mockResolvedValue(createDbUser({ status: 'inactive' }));

      const response = await GET(makeRequest());

      expect(session.destroy).toHaveBeenCalled();
      expect(response.status).toBe(307);
      expect(getRedirectLocation(response)).toBe('/login?error=account_suspended');
    });
  });

  describe('successful sync', () => {
    it('patches session fields and redirects to returnTo', async () => {
      const session = createMockSession({
        activeMode: 'client',
        platformRole: 'user',
        onboardingCompleted: false,
        expertProfileId: undefined,
      });
      mockGetSession.mockResolvedValue(session);
      mockFindForSessionSync.mockResolvedValue(
        createDbUser({
          activeMode: 'expert',
          platformRole: 'admin',
          onboardingCompleted: true,
          expertProfileId: 'ep-789',
        })
      );

      const response = await GET(makeRequest('returnTo=/settings'));

      expect(session.user.activeMode).toBe('expert');
      expect(session.user.platformRole).toBe('admin');
      expect(session.user.onboardingCompleted).toBe(true);
      expect(session.user.expertProfileId).toBe('ep-789');
      expect(session.save).toHaveBeenCalled();
      expect(response.status).toBe(307);
      expect(getRedirectLocation(response)).toBe('/settings');
    });

    it('sets expertProfileId to undefined when DB value is null', async () => {
      const session = createMockSession({ expertProfileId: 'ep-old' });
      mockGetSession.mockResolvedValue(session);
      mockFindForSessionSync.mockResolvedValue(createDbUser({ expertProfileId: null }));

      const response = await GET(makeRequest('returnTo=/dashboard'));

      expect(session.user.expertProfileId).toBeUndefined();
      expect(session.save).toHaveBeenCalled();
      expect(response.status).toBe(307);
      expect(getRedirectLocation(response)).toBe('/dashboard');
    });
  });

  describe('returnTo handling', () => {
    it('defaults to /dashboard when returnTo is missing', async () => {
      const session = createMockSession();
      mockGetSession.mockResolvedValue(session);
      mockFindForSessionSync.mockResolvedValue(createDbUser());

      const response = await GET(makeRequest());

      expect(response.status).toBe(307);
      expect(getRedirectLocation(response)).toBe('/dashboard');
    });

    it('defaults to /dashboard when returnTo is empty string', async () => {
      const session = createMockSession();
      mockGetSession.mockResolvedValue(session);
      mockFindForSessionSync.mockResolvedValue(createDbUser());

      const response = await GET(makeRequest('returnTo='));

      expect(response.status).toBe(307);
      expect(getRedirectLocation(response)).toBe('/dashboard');
    });

    it('rejects absolute URL returnTo (open redirect)', async () => {
      const session = createMockSession();
      mockGetSession.mockResolvedValue(session);
      mockFindForSessionSync.mockResolvedValue(createDbUser());

      const response = await GET(makeRequest('returnTo=https://evil.com'));

      expect(response.status).toBe(307);
      expect(getRedirectLocation(response)).toBe('/dashboard');
    });

    it('rejects protocol-relative returnTo', async () => {
      const session = createMockSession();
      mockGetSession.mockResolvedValue(session);
      mockFindForSessionSync.mockResolvedValue(createDbUser());

      const response = await GET(makeRequest('returnTo=//evil.com'));

      expect(response.status).toBe(307);
      expect(getRedirectLocation(response)).toBe('/dashboard');
    });

    it('allows same-origin path with colon (not a real redirect)', async () => {
      const session = createMockSession();
      mockGetSession.mockResolvedValue(session);
      mockFindForSessionSync.mockResolvedValue(createDbUser());

      const response = await GET(makeRequest('returnTo=/foo://bar'));

      // URL parsing confirms this is a same-origin path, not an open redirect
      expect(response.status).toBe(307);
      expect(getRedirectLocation(response)).toBe('/foo://bar');
    });

    it('rejects returnTo pointing to /login', async () => {
      const session = createMockSession();
      mockGetSession.mockResolvedValue(session);
      mockFindForSessionSync.mockResolvedValue(createDbUser());

      const response = await GET(makeRequest('returnTo=/login'));

      expect(response.status).toBe(307);
      expect(getRedirectLocation(response)).toBe('/dashboard');
    });

    it('rejects returnTo pointing to /signup', async () => {
      const session = createMockSession();
      mockGetSession.mockResolvedValue(session);
      mockFindForSessionSync.mockResolvedValue(createDbUser());

      const response = await GET(makeRequest('returnTo=/signup'));

      expect(response.status).toBe(307);
      expect(getRedirectLocation(response)).toBe('/dashboard');
    });

    it('normalizes backslash in returnTo to forward slash', async () => {
      const session = createMockSession();
      mockGetSession.mockResolvedValue(session);
      mockFindForSessionSync.mockResolvedValue(createDbUser());

      const response = await GET(makeRequest('returnTo=/foo\\bar'));

      // URL parsing normalizes backslash to forward slash — safe same-origin path
      expect(response.status).toBe(307);
      expect(getRedirectLocation(response)).toBe('/foo/bar');
    });

    it('accepts valid relative path returnTo', async () => {
      const session = createMockSession();
      mockGetSession.mockResolvedValue(session);
      mockFindForSessionSync.mockResolvedValue(createDbUser());

      const response = await GET(makeRequest('returnTo=/projects/123'));

      expect(response.status).toBe(307);
      expect(getRedirectLocation(response)).toBe('/projects/123');
    });
  });
});
