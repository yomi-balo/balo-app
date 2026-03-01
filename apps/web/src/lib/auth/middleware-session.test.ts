import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ── Mocks ───────────────────────────────────────────────────────

const mockGetIronSession = vi.fn();
vi.mock('iron-session', () => ({
  getIronSession: (...args: unknown[]) => mockGetIronSession(...args),
}));

const mockAuthenticateWithRefreshToken = vi.fn();
vi.mock('@workos-inc/node', () => {
  // Must use a regular function (not arrow) because it's called with `new`
  function MockWorkOS() {
    return {
      userManagement: {
        authenticateWithRefreshToken: (...args: unknown[]) =>
          mockAuthenticateWithRefreshToken(...args),
      },
    };
  }
  return { WorkOS: MockWorkOS };
});

vi.mock('./session-config', () => ({
  sessionConfig: {
    password: 'test-password-that-is-at-least-32-chars!!',
    cookieName: 'balo_session',
    cookieOptions: { secure: false, httpOnly: true, sameSite: 'lax', maxAge: 604800 },
  },
}));

import {
  getMiddlewareSession,
  refreshSessionIfNeeded,
  clearMiddlewareSession,
} from './middleware-session';

// ── Helpers ─────────────────────────────────────────────────────

function createRequest(path = '/dashboard'): NextRequest {
  return new NextRequest(new URL(path, 'http://localhost:3000'));
}

/**
 * Build a fake JWT with a controlled payload.
 * Uses base64url encoding (the inverse of what getTokenExpiry decodes).
 */
function createJwt(payload: Record<string, unknown>): string {
  const header = toBase64Url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const body = toBase64Url(JSON.stringify(payload));
  return `${header}.${body}.fake-sig`;
}

function toBase64Url(str: string): string {
  return btoa(str).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function createExpiredToken(): string {
  return createJwt({ exp: Math.floor(Date.now() / 1000) - 100 });
}

function createValidToken(): string {
  return createJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
}

function createAlmostExpiredToken(): string {
  return createJwt({ exp: Math.floor(Date.now() / 1000) + 30 });
}

function mockSessionData(overrides: Record<string, unknown> = {}) {
  return {
    user: { id: 'user-1', email: 'test@example.com' },
    accessToken: createValidToken(),
    refreshToken: 'rt_test',
    save: vi.fn(),
    destroy: vi.fn(),
    updateConfig: vi.fn(),
    ...overrides,
  };
}

// ── Environment ─────────────────────────────────────────────────

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.WORKOS_API_KEY = 'sk_test_key';
  process.env.WORKOS_CLIENT_ID = 'client_test_id';
});

afterEach(() => {
  process.env = { ...originalEnv };
});

// ── Tests ───────────────────────────────────────────────────────

describe('getMiddlewareSession', () => {
  it('calls getIronSession with request, a NextResponse, and sessionConfig', async () => {
    const session = mockSessionData();
    mockGetIronSession.mockResolvedValue(session);

    const request = createRequest();
    await getMiddlewareSession(request);

    expect(mockGetIronSession).toHaveBeenCalledOnce();
    const [reqArg, , configArg] = mockGetIronSession.mock.calls[0] as unknown[];
    expect(reqArg).toBe(request);
    expect(configArg).toEqual(expect.objectContaining({ cookieName: 'balo_session' }));
  });

  it('returns an object with session and response properties', async () => {
    mockGetIronSession.mockResolvedValue(mockSessionData());
    const result = await getMiddlewareSession(createRequest());
    expect(result).toHaveProperty('session');
    expect(result).toHaveProperty('response');
  });

  it('response is a NextResponse instance', async () => {
    mockGetIronSession.mockResolvedValue(mockSessionData());
    const result = await getMiddlewareSession(createRequest());
    expect(result.response).toBeInstanceOf(NextResponse);
  });
});

describe('refreshSessionIfNeeded', () => {
  describe('skip refresh — no tokens', () => {
    it('returns null when session has no accessToken', async () => {
      const session = mockSessionData({ accessToken: undefined });
      const result = await refreshSessionIfNeeded(createRequest(), session as never);
      expect(result).toBeNull();
      expect(mockAuthenticateWithRefreshToken).not.toHaveBeenCalled();
    });

    it('returns null when session has no refreshToken', async () => {
      const session = mockSessionData({ refreshToken: undefined });
      const result = await refreshSessionIfNeeded(createRequest(), session as never);
      expect(result).toBeNull();
    });

    it('returns null when both tokens are missing', async () => {
      const session = mockSessionData({ accessToken: undefined, refreshToken: undefined });
      const result = await refreshSessionIfNeeded(createRequest(), session as never);
      expect(result).toBeNull();
    });
  });

  describe('skip refresh — token still valid', () => {
    it('returns null when access token is not expired', async () => {
      const session = mockSessionData({ accessToken: createValidToken() });
      const result = await refreshSessionIfNeeded(createRequest(), session as never);
      expect(result).toBeNull();
      expect(mockAuthenticateWithRefreshToken).not.toHaveBeenCalled();
    });
  });

  describe('token expiry detection', () => {
    it('triggers refresh when token is expired (exp in the past)', async () => {
      const session = mockSessionData({ accessToken: createExpiredToken() });
      const updatedSession = mockSessionData();
      mockGetIronSession.mockResolvedValue(updatedSession);
      mockAuthenticateWithRefreshToken.mockResolvedValue({
        accessToken: 'new-at',
        refreshToken: 'new-rt',
      });

      await refreshSessionIfNeeded(createRequest(), session as never);
      expect(mockAuthenticateWithRefreshToken).toHaveBeenCalled();
    });

    it('triggers refresh when token is within 60s buffer window', async () => {
      const session = mockSessionData({ accessToken: createAlmostExpiredToken() });
      const updatedSession = mockSessionData();
      mockGetIronSession.mockResolvedValue(updatedSession);
      mockAuthenticateWithRefreshToken.mockResolvedValue({
        accessToken: 'new-at',
        refreshToken: 'new-rt',
      });

      await refreshSessionIfNeeded(createRequest(), session as never);
      expect(mockAuthenticateWithRefreshToken).toHaveBeenCalled();
    });

    it('triggers refresh when token payload is not valid base64', async () => {
      const session = mockSessionData({ accessToken: 'header.not-valid-base64!.sig' });
      const updatedSession = mockSessionData();
      mockGetIronSession.mockResolvedValue(updatedSession);
      mockAuthenticateWithRefreshToken.mockResolvedValue({
        accessToken: 'new-at',
        refreshToken: 'new-rt',
      });

      await refreshSessionIfNeeded(createRequest(), session as never);
      expect(mockAuthenticateWithRefreshToken).toHaveBeenCalled();
    });

    it('triggers refresh when token has fewer than 3 parts', async () => {
      const session = mockSessionData({ accessToken: 'only.two' });
      const updatedSession = mockSessionData();
      mockGetIronSession.mockResolvedValue(updatedSession);
      mockAuthenticateWithRefreshToken.mockResolvedValue({
        accessToken: 'new-at',
        refreshToken: 'new-rt',
      });

      await refreshSessionIfNeeded(createRequest(), session as never);
      expect(mockAuthenticateWithRefreshToken).toHaveBeenCalled();
    });

    it('triggers refresh when token payload JSON has no exp claim', async () => {
      const session = mockSessionData({
        accessToken: createJwt({ sub: 'user-1' }),
      });
      const updatedSession = mockSessionData();
      mockGetIronSession.mockResolvedValue(updatedSession);
      mockAuthenticateWithRefreshToken.mockResolvedValue({
        accessToken: 'new-at',
        refreshToken: 'new-rt',
      });

      await refreshSessionIfNeeded(createRequest(), session as never);
      expect(mockAuthenticateWithRefreshToken).toHaveBeenCalled();
    });

    it('triggers refresh when token payload is not valid JSON', async () => {
      const invalidPayload = toBase64Url('not-json');
      const token = `header.${invalidPayload}.sig`;
      const session = mockSessionData({ accessToken: token });
      const updatedSession = mockSessionData();
      mockGetIronSession.mockResolvedValue(updatedSession);
      mockAuthenticateWithRefreshToken.mockResolvedValue({
        accessToken: 'new-at',
        refreshToken: 'new-rt',
      });

      await refreshSessionIfNeeded(createRequest(), session as never);
      expect(mockAuthenticateWithRefreshToken).toHaveBeenCalled();
    });
  });

  describe('successful refresh', () => {
    it('calls authenticateWithRefreshToken with clientId and refreshToken', async () => {
      const session = mockSessionData({ accessToken: createExpiredToken() });
      const updatedSession = mockSessionData();
      mockGetIronSession.mockResolvedValue(updatedSession);
      mockAuthenticateWithRefreshToken.mockResolvedValue({
        accessToken: 'new-at',
        refreshToken: 'new-rt',
      });

      await refreshSessionIfNeeded(createRequest(), session as never);

      expect(mockAuthenticateWithRefreshToken).toHaveBeenCalledWith({
        clientId: 'client_test_id',
        refreshToken: 'rt_test',
      });
    });

    it('creates a new session with updated tokens', async () => {
      const session = mockSessionData({ accessToken: createExpiredToken() });
      const updatedSession = mockSessionData();
      mockGetIronSession.mockResolvedValue(updatedSession);
      mockAuthenticateWithRefreshToken.mockResolvedValue({
        accessToken: 'new-at',
        refreshToken: 'new-rt',
      });

      await refreshSessionIfNeeded(createRequest(), session as never);

      expect(updatedSession.accessToken).toBe('new-at');
      expect(updatedSession.refreshToken).toBe('new-rt');
    });

    it('preserves original session.user in the refreshed session', async () => {
      const originalUser = { id: 'user-1', email: 'test@example.com' };
      const session = mockSessionData({ accessToken: createExpiredToken(), user: originalUser });
      const updatedSession = mockSessionData();
      mockGetIronSession.mockResolvedValue(updatedSession);
      mockAuthenticateWithRefreshToken.mockResolvedValue({
        accessToken: 'new-at',
        refreshToken: 'new-rt',
      });

      await refreshSessionIfNeeded(createRequest(), session as never);

      expect(updatedSession.user).toEqual(originalUser);
    });

    it('calls save() on the updated session', async () => {
      const session = mockSessionData({ accessToken: createExpiredToken() });
      const updatedSession = mockSessionData();
      mockGetIronSession.mockResolvedValue(updatedSession);
      mockAuthenticateWithRefreshToken.mockResolvedValue({
        accessToken: 'new-at',
        refreshToken: 'new-rt',
      });

      await refreshSessionIfNeeded(createRequest(), session as never);

      expect(updatedSession.save).toHaveBeenCalledOnce();
    });

    it('returns a NextResponse (not null)', async () => {
      const session = mockSessionData({ accessToken: createExpiredToken() });
      const updatedSession = mockSessionData();
      mockGetIronSession.mockResolvedValue(updatedSession);
      mockAuthenticateWithRefreshToken.mockResolvedValue({
        accessToken: 'new-at',
        refreshToken: 'new-rt',
      });

      const result = await refreshSessionIfNeeded(createRequest(), session as never);
      expect(result).not.toBeNull();
      expect(result).toBeInstanceOf(NextResponse);
    });
  });

  describe('refresh failure', () => {
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      consoleLogSpy.mockRestore();
    });

    it('returns null when authenticateWithRefreshToken throws', async () => {
      const session = mockSessionData({ accessToken: createExpiredToken() });
      mockAuthenticateWithRefreshToken.mockRejectedValue(new Error('token revoked'));

      const result = await refreshSessionIfNeeded(createRequest(), session as never);
      expect(result).toBeNull();
    });

    it('logs a structured warning when refresh fails', async () => {
      const session = mockSessionData({ accessToken: createExpiredToken() });
      mockAuthenticateWithRefreshToken.mockRejectedValue(new Error('token revoked'));

      await refreshSessionIfNeeded(createRequest(), session as never);

      expect(consoleLogSpy).toHaveBeenCalledOnce();
      const logArg = consoleLogSpy.mock.calls[0]?.[0] as string;
      const parsed = JSON.parse(logArg) as Record<string, unknown>;
      expect(parsed.level).toBe('warn');
      expect(parsed.msg).toBe('Token refresh failed');
      expect(parsed.error).toBe('token revoked');
    });

    it('includes "Unknown" as error when non-Error is thrown', async () => {
      const session = mockSessionData({ accessToken: createExpiredToken() });
      mockAuthenticateWithRefreshToken.mockRejectedValue('some string error');

      await refreshSessionIfNeeded(createRequest(), session as never);

      const logArg = consoleLogSpy.mock.calls[0]?.[0] as string;
      const parsed = JSON.parse(logArg) as Record<string, unknown>;
      expect(parsed.error).toBe('Unknown');
    });
  });
});

describe('clearMiddlewareSession', () => {
  it('calls getIronSession with request, response, and sessionConfig', async () => {
    const session = mockSessionData();
    mockGetIronSession.mockResolvedValue(session);

    await clearMiddlewareSession(createRequest());

    expect(mockGetIronSession).toHaveBeenCalledOnce();
  });

  it('calls session.destroy() on the resolved session', async () => {
    const session = mockSessionData();
    mockGetIronSession.mockResolvedValue(session);

    await clearMiddlewareSession(createRequest());

    expect(session.destroy).toHaveBeenCalledOnce();
  });

  it('returns a NextResponse', async () => {
    mockGetIronSession.mockResolvedValue(mockSessionData());

    const result = await clearMiddlewareSession(createRequest());
    expect(result).toBeInstanceOf(NextResponse);
  });
});
