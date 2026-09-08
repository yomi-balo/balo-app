import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IronSession } from 'iron-session';
import { NextRequest, NextResponse } from 'next/server';
import type { SessionData } from './session';

// ── Mocks ───────────────────────────────────────────────────────

const mockGetIronSession = vi.fn();
vi.mock('iron-session', () => ({
  getIronSession: (...args: unknown[]) => mockGetIronSession(...args),
}));

const mockAuthenticateWithRefreshToken = vi.fn();
// Must be a regular function (not arrow) because it's called with `new WorkOS()`
function MockWorkOS() {
  // NOSONAR — intentionally inside module scope for vi.mock hoisting
  return {
    userManagement: {
      authenticateWithRefreshToken: (...args: unknown[]) =>
        mockAuthenticateWithRefreshToken(...args),
    },
  };
}
vi.mock('@workos-inc/node', () => ({ WorkOS: MockWorkOS }));

// BAL-553 fix round 1, S3 — widened to keep the REAL `impersonatedSessionConfig` /
// `IMPERSONATED_SESSION_MAX_AGE_SECONDS` in play (only `sessionConfig` itself is overridden for
// a deterministic test password), so the re-arm tests below exercise the genuine TTL seam rather
// than a hand-rolled stand-in.
vi.mock('./session-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./session-config')>();
  return {
    ...actual,
    sessionConfig: {
      password: 'test-password-that-is-at-least-32-chars!!', // NOSONAR — test fixture, not a real credential
      cookieName: 'balo_session',
      cookieOptions: { secure: false, httpOnly: true, sameSite: 'lax', maxAge: 604800 },
    },
  };
});

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

/** Typed wrapper — one cast in one place rather than scattered `as never`. */
function mockSession(overrides: Record<string, unknown> = {}): IronSession<SessionData> {
  return mockSessionData(overrides) as unknown as IronSession<SessionData>;
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
      const session = mockSession({ accessToken: undefined });
      const result = await refreshSessionIfNeeded(createRequest(), session);
      expect(result).toBeNull();
      expect(mockAuthenticateWithRefreshToken).not.toHaveBeenCalled();
    });

    it('returns null when session has no refreshToken', async () => {
      const session = mockSession({ refreshToken: undefined });
      const result = await refreshSessionIfNeeded(createRequest(), session);
      expect(result).toBeNull();
    });

    it('returns null when both tokens are missing', async () => {
      const session = mockSession({ accessToken: undefined, refreshToken: undefined });
      const result = await refreshSessionIfNeeded(createRequest(), session);
      expect(result).toBeNull();
    });
  });

  describe('skip refresh — token still valid', () => {
    it('returns null when access token is not expired', async () => {
      const session = mockSession({ accessToken: createValidToken() });
      const result = await refreshSessionIfNeeded(createRequest(), session);
      expect(result).toBeNull();
      expect(mockAuthenticateWithRefreshToken).not.toHaveBeenCalled();
    });
  });

  describe('token expiry detection', () => {
    /** Setup mocks so refresh proceeds when triggered by an invalid/expired token */
    function setupRefreshMocks(): void {
      mockGetIronSession.mockResolvedValue(mockSessionData());
      mockAuthenticateWithRefreshToken.mockResolvedValue({
        accessToken: 'new-at',
        refreshToken: 'new-rt',
      });
    }

    it.each([
      ['expired (exp in the past)', createExpiredToken()],
      ['within 60s buffer window', createAlmostExpiredToken()],
      ['not valid base64 payload', 'header.not-valid-base64!.sig'],
      ['fewer than 3 parts', 'only.two'],
      ['no exp claim in payload', createJwt({ sub: 'user-1' })],
    ])('triggers refresh when token is %s', async (_label, accessToken) => {
      setupRefreshMocks();
      const session = mockSession({ accessToken });
      await refreshSessionIfNeeded(createRequest(), session);
      expect(mockAuthenticateWithRefreshToken).toHaveBeenCalled();
    });

    it('triggers refresh when token payload is not valid JSON', async () => {
      setupRefreshMocks();
      const invalidPayload = toBase64Url('not-json');
      const token = `header.${invalidPayload}.sig`;
      const session = mockSession({ accessToken: token });

      await refreshSessionIfNeeded(createRequest(), session);
      expect(mockAuthenticateWithRefreshToken).toHaveBeenCalled();
    });
  });

  describe('successful refresh', () => {
    it('calls authenticateWithRefreshToken with clientId and refreshToken', async () => {
      const session = mockSession({ accessToken: createExpiredToken() });
      const updatedSession = mockSessionData();
      mockGetIronSession.mockResolvedValue(updatedSession);
      mockAuthenticateWithRefreshToken.mockResolvedValue({
        accessToken: 'new-at',
        refreshToken: 'new-rt',
      });

      await refreshSessionIfNeeded(createRequest(), session);

      expect(mockAuthenticateWithRefreshToken).toHaveBeenCalledWith({
        clientId: 'client_test_id',
        refreshToken: 'rt_test',
      });
    });

    it('creates a new session with updated tokens', async () => {
      const session = mockSession({ accessToken: createExpiredToken() });
      const updatedSession = mockSessionData();
      mockGetIronSession.mockResolvedValue(updatedSession);
      mockAuthenticateWithRefreshToken.mockResolvedValue({
        accessToken: 'new-at',
        refreshToken: 'new-rt',
      });

      await refreshSessionIfNeeded(createRequest(), session);

      expect(updatedSession.accessToken).toBe('new-at');
      expect(updatedSession.refreshToken).toBe('new-rt');
    });

    it('preserves original session.user in the refreshed session', async () => {
      const originalUser = { id: 'user-1', email: 'test@example.com' };
      const session = mockSession({ accessToken: createExpiredToken(), user: originalUser });
      const updatedSession = mockSessionData();
      mockGetIronSession.mockResolvedValue(updatedSession);
      mockAuthenticateWithRefreshToken.mockResolvedValue({
        accessToken: 'new-at',
        refreshToken: 'new-rt',
      });

      await refreshSessionIfNeeded(createRequest(), session);

      expect(updatedSession.user).toEqual(originalUser);
    });

    it('calls save() on the updated session', async () => {
      const session = mockSession({ accessToken: createExpiredToken() });
      const updatedSession = mockSessionData();
      mockGetIronSession.mockResolvedValue(updatedSession);
      mockAuthenticateWithRefreshToken.mockResolvedValue({
        accessToken: 'new-at',
        refreshToken: 'new-rt',
      });

      await refreshSessionIfNeeded(createRequest(), session);

      expect(updatedSession.save).toHaveBeenCalledOnce();
    });

    it('returns a NextResponse (not null)', async () => {
      const session = mockSession({ accessToken: createExpiredToken() });
      const updatedSession = mockSessionData();
      mockGetIronSession.mockResolvedValue(updatedSession);
      mockAuthenticateWithRefreshToken.mockResolvedValue({
        accessToken: 'new-at',
        refreshToken: 'new-rt',
      });

      const result = await refreshSessionIfNeeded(createRequest(), session);
      expect(result).not.toBeNull();
      expect(result).toBeInstanceOf(NextResponse);
    });

    // BAL-553 fix round 1, S3 — this path is unreachable in production TODAY only because an
    // impersonated session carries no tokens (the early return above). These tests prove the
    // DEFENSIVE re-arm works on its own terms, independent of that coupling: if tokens were ever
    // present on an impersonated session, this save must NOT promote it to the 7-day cookie.
    describe('S3 — re-arms the TTL config for an impersonated session before save()', () => {
      it('calls updateConfig with the REMAINING time (not the 7-day default) when impersonatorUserId is present', async () => {
        const expiresAt = Date.now() + 15 * 60 * 1000; // 15 minutes left
        // `refreshSessionIfNeeded` copies `session.user` onto `updatedSession.user` (line
        // `updatedSession.user = session.user`) — the impersonation fields must be seeded on
        // the ORIGINAL `session` argument, not on `updatedSession`, or they are overwritten.
        const session = mockSession({
          accessToken: createExpiredToken(),
          user: {
            id: 'target-1',
            impersonatorUserId: 'admin-1',
            impersonationExpiresAt: expiresAt,
          },
        });
        const updatedSession = mockSessionData();
        mockGetIronSession.mockResolvedValue(updatedSession);
        mockAuthenticateWithRefreshToken.mockResolvedValue({
          accessToken: 'new-at',
          refreshToken: 'new-rt',
        });

        await refreshSessionIfNeeded(createRequest(), session);

        expect(updatedSession.updateConfig).toHaveBeenCalledTimes(1);
        const [config] = updatedSession.updateConfig.mock.calls[0] as [{ ttl: number }];
        expect(config.ttl).toBe(15 * 60);
        // The re-arm must happen BEFORE save() — not after.
        const [updateOrder] = updatedSession.updateConfig.mock.invocationCallOrder;
        const [saveOrder] = updatedSession.save.mock.invocationCallOrder;
        if (updateOrder === undefined) throw new Error('expected updateConfig to have been called');
        if (saveOrder === undefined) throw new Error('expected save to have been called');
        expect(updateOrder).toBeLessThan(saveOrder);
      });

      it('does NOT call updateConfig for a normal (non-impersonated) session', async () => {
        const session = mockSession({ accessToken: createExpiredToken() });
        const updatedSession = mockSessionData({ user: { id: 'user-1' } });
        mockGetIronSession.mockResolvedValue(updatedSession);
        mockAuthenticateWithRefreshToken.mockResolvedValue({
          accessToken: 'new-at',
          refreshToken: 'new-rt',
        });

        await refreshSessionIfNeeded(createRequest(), session);

        expect(updatedSession.updateConfig).not.toHaveBeenCalled();
      });
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
      const session = mockSession({ accessToken: createExpiredToken() });
      mockAuthenticateWithRefreshToken.mockRejectedValue(new Error('token revoked'));

      const result = await refreshSessionIfNeeded(createRequest(), session);
      expect(result).toBeNull();
    });

    it('logs a structured warning when refresh fails', async () => {
      const session = mockSession({ accessToken: createExpiredToken() });
      mockAuthenticateWithRefreshToken.mockRejectedValue(new Error('token revoked'));

      await refreshSessionIfNeeded(createRequest(), session);

      expect(consoleLogSpy).toHaveBeenCalledOnce();
      const logArg = consoleLogSpy.mock.calls[0]?.[0] as string;
      const parsed = JSON.parse(logArg) as Record<string, unknown>;
      expect(parsed.level).toBe('warn');
      expect(parsed.msg).toBe('Token refresh failed');
      expect(parsed.error).toBe('token revoked');
    });

    it('includes "Unknown" as error when non-Error is thrown', async () => {
      const session = mockSession({ accessToken: createExpiredToken() });
      mockAuthenticateWithRefreshToken.mockRejectedValue('some string error');

      await refreshSessionIfNeeded(createRequest(), session);

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
