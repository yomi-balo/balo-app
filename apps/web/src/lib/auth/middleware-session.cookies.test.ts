import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sealData, unsealData } from 'iron-session';
import { NextRequest } from 'next/server';
import type { SessionData } from './session';

/**
 * The REAL cookie mechanics of a middleware refresh — real iron-session sealing, a real
 * `NextRequest`/`NextResponse`. `middleware-session.test.ts` mocks `getIronSession` wholesale, so
 * it can assert what the refresh assigns but never HOW the cookie leaves: whether the request
 * being handled is forwarded with the new seal, or only the browser receives it.
 */

const PASSWORD = 'test-password-that-is-at-least-32-chars!!'; // NOSONAR — test fixture, not a real credential
const COOKIE = 'balo_session';
const WEEK_SECONDS = 604800;

vi.mock('./session-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./session-config')>();
  return {
    ...actual,
    sessionConfig: {
      password: 'test-password-that-is-at-least-32-chars!!', // NOSONAR — test fixture
      cookieName: 'balo_session',
      cookieOptions: { secure: false, httpOnly: true, sameSite: 'lax', maxAge: 604800 },
    },
  };
});

const mockAuthenticateWithRefreshToken = vi.fn();
function MockWorkOS() {
  return {
    userManagement: {
      authenticateWithRefreshToken: (...args: unknown[]) =>
        mockAuthenticateWithRefreshToken(...args),
    },
  };
}
vi.mock('@workos-inc/node', () => ({ WorkOS: MockWorkOS }));

import { getMiddlewareSession, refreshSessionIfNeeded } from './middleware-session';

function jwtExpiringIn(seconds: number): string {
  const b64url = (v: string): string =>
    btoa(v).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  return `${b64url('{"alg":"none"}')}.${b64url(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds })
  )}.sig`;
}

const USER = {
  id: 'user-1',
  email: 'expert@example.com',
  companyId: 'company-1',
  companyName: 'Acme',
  companyRole: 'owner',
} as unknown as NonNullable<SessionData['user']>;

async function requestCarrying(data: SessionData): Promise<NextRequest> {
  const seal = await sealData(data, { password: PASSWORD });
  return new NextRequest(new URL('/expert/settings', 'http://localhost:3000'), {
    headers: {
      cookie: `ph_session=abc%20def; ${COOKIE}=${seal}; theme=dark`,
      'user-agent': 'vitest',
      'x-forwarded-for': '203.0.113.7',
    },
  });
}

/** The `balo_session` value out of one `balo_session=value; attr…` Set-Cookie string. */
function sealFromSetCookie(setCookie: string): string {
  const prefix = `${COOKIE}=`;
  if (!setCookie.startsWith(prefix)) throw new Error(`not a ${COOKIE} cookie: ${setCookie}`);
  const end = setCookie.indexOf(';');
  return decodeURIComponent(setCookie.slice(prefix.length, end === -1 ? undefined : end));
}

/** The `balo_session` value out of a request `cookie` header (`a=1; balo_session=…; b=2`). */
function sealFromCookieHeader(header: string): string {
  const entry = header.split('; ').find((pair) => pair.startsWith(`${COOKIE}=`));
  if (entry === undefined) throw new Error(`no ${COOKIE} in cookie header: ${header}`);
  return decodeURIComponent(entry.slice(COOKIE.length + 1));
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.WORKOS_API_KEY = 'sk_test_key';
  process.env.WORKOS_CLIENT_ID = 'client_test_id';
  mockAuthenticateWithRefreshToken.mockResolvedValue({
    accessToken: 'new-access-token',
    refreshToken: 'new-refresh-token',
  });
});

describe('refreshSessionIfNeeded — the refreshed cookie reaches THIS request', () => {
  it('⚠ forwards THIS request with the new seal in its cookie header', async () => {
    const request = await requestCarrying({
      user: USER,
      accessToken: jwtExpiringIn(-120),
      refreshToken: 'old-refresh-token',
    });
    const { session } = await getMiddlewareSession(request);

    const response = await refreshSessionIfNeeded(request, session);

    const overridden = (response?.headers.get('x-middleware-override-headers') ?? '').split(',');
    expect(overridden).toContain('cookie');
    const forwardedCookie = response?.headers.get('x-middleware-request-cookie') ?? '';
    const unsealed = await unsealData<SessionData>(sealFromCookieHeader(forwardedCookie), {
      password: PASSWORD,
    });
    expect(unsealed.accessToken).toBe('new-access-token');
    expect(unsealed.refreshToken).toBe('new-refresh-token');
    expect(unsealed.user).toEqual(USER);
  });

  it('⚠ does NOT use x-middleware-set-cookie — a Server Action would count it as a cookie it changed', async () => {
    const request = await requestCarrying({
      user: USER,
      accessToken: jwtExpiringIn(-120),
      refreshToken: 'old-refresh-token',
    });
    const { session } = await getMiddlewareSession(request);

    const response = await refreshSessionIfNeeded(request, session);

    expect(response?.headers.has('x-middleware-set-cookie')).toBe(false);
  });

  it('keeps every other request header and cookie — Next drops any header missing from the override', async () => {
    const request = await requestCarrying({
      user: USER,
      accessToken: jwtExpiringIn(-120),
      refreshToken: 'old-refresh-token',
    });
    const { session } = await getMiddlewareSession(request);

    const response = await refreshSessionIfNeeded(request, session);

    const overridden = (response?.headers.get('x-middleware-override-headers') ?? '').split(',');
    expect(overridden).toEqual(expect.arrayContaining(['user-agent', 'x-forwarded-for']));
    expect(response?.headers.get('x-middleware-request-user-agent')).toBe('vitest');
    const forwardedCookie = response?.headers.get('x-middleware-request-cookie') ?? '';
    expect(forwardedCookie).toContain('ph_session=abc%20def');
    expect(forwardedCookie).toContain('theme=dark');
    // The request itself is not mutated: only the forwarded copy carries the new seal.
    expect(request.cookies.get(COOKIE)?.value).not.toBe(sealFromCookieHeader(forwardedCookie));
  });

  it('still sends the browser exactly ONE balo_session Set-Cookie, with the session attributes', async () => {
    const request = await requestCarrying({
      user: USER,
      accessToken: jwtExpiringIn(-120),
      refreshToken: 'old-refresh-token',
    });
    const { session } = await getMiddlewareSession(request);

    const response = await refreshSessionIfNeeded(request, session);

    const setCookies = (response?.headers.getSetCookie() ?? []).filter((c) =>
      c.startsWith(`${COOKIE}=`)
    );
    expect(setCookies).toHaveLength(1);
    const [cookie] = setCookies;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(new RegExp(`Max-Age=${WEEK_SECONDS}`));
    // The browser gets the same session the request was handed.
    const browserSession = await unsealData<SessionData>(sealFromSetCookie(cookie ?? ''), {
      password: PASSWORD,
    });
    expect(browserSession.accessToken).toBe('new-access-token');
  });

  it('keeps the BAL-553 defensive re-arm: an impersonated session is re-sealed with its REMAINING time', async () => {
    const request = await requestCarrying({
      user: {
        ...USER,
        impersonatorUserId: 'staff-1',
        impersonationExpiresAt: Date.now() + 15 * 60 * 1000,
      } as NonNullable<SessionData['user']>,
      accessToken: jwtExpiringIn(-120),
      refreshToken: 'old-refresh-token',
    });
    const { session } = await getMiddlewareSession(request);

    const response = await refreshSessionIfNeeded(request, session);

    const [cookie] = (response?.headers.getSetCookie() ?? []).filter((c) =>
      c.startsWith(`${COOKIE}=`)
    );
    const maxAge = Number(/Max-Age=(\d+)/i.exec(cookie ?? '')?.[1]);
    expect(maxAge).toBeGreaterThan(14 * 60);
    expect(maxAge).toBeLessThanOrEqual(15 * 60);

    // The SEAL expires with the remaining time too, not iron-session's 14-day default. Positive
    // control first, so an `{}` below cannot come from a wrong password.
    const seal = sealFromSetCookie(cookie ?? '');
    const opened = await unsealData<SessionData>(seal, { password: PASSWORD });
    expect(opened.user?.impersonatorUserId).toBe('staff-1');
    const realNow = Date.now();
    // iron-webcrypto adds a fixed 60s skew allowance to the sealed expiry.
    vi.spyOn(Date, 'now').mockReturnValue(realNow + (15 * 60 + 60 + 5) * 1000);
    try {
      expect(await unsealData<SessionData>(seal, { password: PASSWORD })).toEqual({});
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('writes nothing when the token is still fresh', async () => {
    const request = await requestCarrying({
      user: USER,
      accessToken: jwtExpiringIn(3600),
      refreshToken: 'old-refresh-token',
    });
    const { session } = await getMiddlewareSession(request);

    await expect(refreshSessionIfNeeded(request, session)).resolves.toBeNull();
    expect(mockAuthenticateWithRefreshToken).not.toHaveBeenCalled();
  });
});
