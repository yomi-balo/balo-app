import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────

const {
  mockBuildApirocAuthorizeUrl,
  mockSignConnectState,
  mockVerifyConnectState,
  mockReadStatePayloadUnverified,
  mockPersistApirocConnection,
  mockProvisionConnection,
  mockEnqueueAvailabilityCacheRebuild,
  mockEnqueueSubscriptionReconcile,
} = vi.hoisted(() => ({
  mockBuildApirocAuthorizeUrl: vi.fn(),
  mockSignConnectState: vi.fn(),
  mockVerifyConnectState: vi.fn(),
  mockReadStatePayloadUnverified: vi.fn(),
  mockPersistApirocConnection: vi.fn(),
  mockProvisionConnection: vi.fn(),
  mockEnqueueAvailabilityCacheRebuild: vi.fn(),
  mockEnqueueSubscriptionReconcile: vi.fn(),
}));

vi.mock('../../lib/apiroc/index.js', () => ({
  buildApirocAuthorizeUrl: mockBuildApirocAuthorizeUrl,
}));

// BAL-396 fix round, Finding 1 — `extractCookieValue` / `buildClearConnectNonceCookieHeader` /
// `buildClearAllConnectNonceCookieHeaders` / `calendarConnectNonceCookieName` /
// `calendarConnectCookieDomain` are real (unmocked) so the CSRF-binding tests below exercise the
// actual cookie parsing/clearing logic, not a stub of it.
vi.mock('../../services/calendar/connect-state.js', async () => {
  const actual = await vi.importActual('../../services/calendar/connect-state.js');
  return {
    ...actual,
    signConnectState: mockSignConnectState,
    verifyConnectState: mockVerifyConnectState,
    readStatePayloadUnverified: mockReadStatePayloadUnverified,
  };
});

vi.mock('../../services/calendar/apiroc-connection.js', () => ({
  persistApirocConnection: mockPersistApirocConnection,
  provisionConnection: mockProvisionConnection,
}));

vi.mock('../../jobs/availability-cache.js', () => ({
  enqueueAvailabilityCacheRebuild: mockEnqueueAvailabilityCacheRebuild,
}));

vi.mock('../../jobs/calendar-subscription-reconcile.js', () => ({
  enqueueSubscriptionReconcile: mockEnqueueSubscriptionReconcile,
}));

vi.mock('../../lib/redis.js', () => ({
  getRedis: () => ({}),
  createRedisConnection: () => ({}),
}));

vi.mock('../../lib/queue.js', () => ({
  getQueue: vi.fn(() => ({ add: vi.fn() })),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@balo/db', () => ({
  calendarRepository: {},
}));

vi.mock('@sentry/node', () => ({
  captureException: vi.fn(),
}));

vi.mock('@balo/analytics/server', () => ({
  trackServer: vi.fn(),
  CALENDAR_SERVER_EVENTS: Object.freeze({
    OAUTH_COMPLETED: 'calendar_oauth_completed',
    OAUTH_FAILED: 'calendar_oauth_failed',
  }),
  toCalendarEventProvider: (p: string) => (p === 'google' || p === 'microsoft' ? p : undefined),
}));

import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { trackServer } from '@balo/analytics/server';
import { calendarConnectNonceCookieName } from '../../services/calendar/connect-state.js';

// ── Tests ──────────────────────────────────────────────────────

const TEST_SECRET = 'test-internal-secret';
const EXPERT_UUID = '550e8400-e29b-41d4-a716-446655440000';
const VALID_NONCE = 'nonce-abc-123';

describe('calendar auth routes (BAL-396)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.INTERNAL_API_SECRET = TEST_SECRET;
    process.env.APP_URL = 'https://app.balo.test';
    app = await buildApp({ logger: false });
  });

  afterAll(async () => {
    await app.close();
    delete process.env.INTERNAL_API_SECRET;
    delete process.env.APP_URL;
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function injectConnect(body?: Record<string, unknown>, headers?: Record<string, string>) {
    return app.inject({
      method: 'POST',
      url: '/api/calendar/connect',
      headers: {
        'content-type': 'application/json',
        ...headers,
      },
      ...(body && { payload: body }),
    });
  }

  function injectCallback(query: Record<string, string>, headers?: Record<string, string>) {
    return app.inject({
      method: 'GET',
      url: '/auth/apiroc/callback',
      query,
      headers,
    });
  }

  /** The Cookie header a browser that just went through `POST /api/calendar/connect` would
   *  present at the callback — matches `VALID_NONCE` by default. Scoped by `provider`
   *  (BAL-396 fix round 2, Finding 5) — defaults to 'google' since that is what every
   *  existing SHAPE 2 fixture below signs the state for. */
  function nonceCookieHeader(
    nonce = VALID_NONCE,
    provider: 'google' | 'microsoft' = 'google'
  ): Record<string, string> {
    return { cookie: `${calendarConnectNonceCookieName(provider)}=${nonce}` };
  }

  /** Every `Set-Cookie` value that clears BOTH providers' nonce cookies — the "we don't know
   *  which flow this was" fallback (BAL-396 fix round 2, Finding 5). */
  function allProviderCookieNames(): string[] {
    return [calendarConnectNonceCookieName('google'), calendarConnectNonceCookieName('microsoft')];
  }

  /** Normalises `res.headers['set-cookie']` to an array regardless of whether one or several
   *  `Set-Cookie` headers were sent — Fastify/light-my-request returns a plain string for a
   *  single header and an array once there is more than one (verified empirically; Node's
   *  `http` module never comma-joins `Set-Cookie`, unlike other headers). */
  function setCookieHeaders(res: { headers: Record<string, unknown> }): string[] {
    const raw = res.headers['set-cookie'];
    if (!raw) return [];
    return Array.isArray(raw) ? (raw as string[]) : [raw as string];
  }

  // ── POST /api/calendar/connect ────────────────────────────────

  describe('POST /api/calendar/connect', () => {
    it('returns 401 when no auth header', async () => {
      const res = await injectConnect({ expertProfileId: EXPERT_UUID, provider: 'google' });
      expect(res.statusCode).toBe(401);
    });

    it('returns 400 for invalid body', async () => {
      const res = await injectConnect(
        { expertProfileId: 'not-a-uuid', provider: 'google' },
        { 'x-internal-api-key': TEST_SECRET }
      );
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('Invalid request body');
    });

    it('returns 400 for invalid provider', async () => {
      const res = await injectConnect(
        { expertProfileId: EXPERT_UUID, provider: 'invalid' },
        { 'x-internal-api-key': TEST_SECRET }
      );
      expect(res.statusCode).toBe(400);
    });

    it('returns authUrl and the nonce on success (BAL-396 fix round, Finding 1)', async () => {
      mockSignConnectState.mockReturnValue('signed-state');
      mockVerifyConnectState.mockReturnValue({
        expertProfileId: EXPERT_UUID,
        provider: 'google',
        nonce: VALID_NONCE,
      });
      mockBuildApirocAuthorizeUrl.mockReturnValue('https://api.apiroc.com/oauth/authorize?test=1');

      const res = await injectConnect(
        { expertProfileId: EXPERT_UUID, provider: 'google' },
        { 'x-internal-api-key': TEST_SECRET }
      );

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        authUrl: 'https://api.apiroc.com/oauth/authorize?test=1',
        nonce: VALID_NONCE,
      });
      expect(mockSignConnectState).toHaveBeenCalledWith(EXPERT_UUID, 'google');
      expect(mockBuildApirocAuthorizeUrl).toHaveBeenCalledWith({
        provider: 'google',
        state: 'signed-state',
        externalId: EXPERT_UUID,
      });
    });

    it('returns 500 when buildApirocAuthorizeUrl throws', async () => {
      mockSignConnectState.mockReturnValue('signed-state');
      mockVerifyConnectState.mockReturnValue({
        expertProfileId: EXPERT_UUID,
        provider: 'microsoft',
        nonce: VALID_NONCE,
      });
      mockBuildApirocAuthorizeUrl.mockImplementation(() => {
        throw new Error('APIROC_APP_ID is not set');
      });

      const res = await injectConnect(
        { expertProfileId: EXPERT_UUID, provider: 'microsoft' },
        { 'x-internal-api-key': TEST_SECRET }
      );

      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe('Failed to initiate calendar connection');
    });
  });

  // ── GET /auth/apiroc/callback ─────────────────────────────────

  describe('GET /auth/apiroc/callback', () => {
    // ── Shape 3: neither error nor endUserAccountId ──────────────

    it('SHAPE 3: redirects with invalid_callback and does not crash when neither field is present', async () => {
      const res = await injectCallback({});
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain('calendar_error=invalid_callback');
    });

    it(
      'SHAPE 3: still clears BOTH providers’ CSRF cookies (BAL-396 fix round 2, Finding 5 ' +
        '— a stray/no-op callback carries no provider signal, so every scoped cookie is ' +
        'cleared rather than guessed at)',
      async () => {
        const res = await injectCallback({});
        const setCookie = setCookieHeaders(res);
        expect(setCookie).toHaveLength(2);
        for (const name of allProviderCookieNames()) {
          expect(setCookie.some((c) => c.includes(`${name}=;`))).toBe(true);
        }
        expect(setCookie.every((c) => c.includes('Max-Age=0'))).toBe(true);
      }
    );

    // ── Shape 1: error present — branched FIRST ───────────────────

    it('SHAPE 1: a partial grant persists no row (no connection service is ever called)', async () => {
      mockReadStatePayloadUnverified.mockReturnValue({});

      const res = await injectCallback({ error: 'missing_required_permissions' });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain('calendar_error=partial_grant');
      expect(mockPersistApirocConnection).not.toHaveBeenCalled();
      expect(mockProvisionConnection).not.toHaveBeenCalled();
    });

    it('SHAPE 1 — the ticket-mandatory O365 round trip: access_denied ⇒ o365_admin_approval AND calendar_provider=microsoft', async () => {
      mockReadStatePayloadUnverified.mockReturnValue({
        expertProfileId: EXPERT_UUID,
        provider: 'microsoft',
      });

      const res = await injectCallback({ error: 'access_denied', state: 'microsoft-state' });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain('calendar_error=o365_admin_approval');
      expect(res.headers.location).toContain('calendar_provider=microsoft');
      expect(trackServer).toHaveBeenCalledWith('calendar_oauth_failed', {
        error_code: 'o365_admin_approval',
        provider: 'microsoft',
        distinct_id: EXPERT_UUID,
      });
      // BAL-396 fix round 2, Finding 5 — the unverified state named 'microsoft', so ONLY that
      // provider's cookie is cleared, not the google one too (which a concurrent, still
      // in-flight Google connect attempt may hold).
      const setCookie = setCookieHeaders(res);
      expect(setCookie).toHaveLength(1);
      expect(setCookie[0]).toContain(`${calendarConnectNonceCookieName('microsoft')}=;`);
    });

    it('SHAPE 1: consent_required also classifies as o365_admin_approval', async () => {
      mockReadStatePayloadUnverified.mockReturnValue({ provider: 'microsoft' });
      const res = await injectCallback({ error: 'consent_required', state: 's' });
      expect(res.headers.location).toContain('calendar_error=o365_admin_approval');
    });

    it('SHAPE 1: an unclassified error redirects callback_failed and logs the named marker (no throw)', async () => {
      mockReadStatePayloadUnverified.mockReturnValue({});
      const res = await injectCallback({ error: 'some_unknown_thing' });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain('calendar_error=callback_failed');
    });

    it('SHAPE 1: distinct_id falls back to "unknown" when the state carries no expertProfileId', async () => {
      mockReadStatePayloadUnverified.mockReturnValue({});
      await injectCallback({ error: 'missing_required_permissions', state: 'garbage' });
      expect(trackServer).toHaveBeenCalledWith(
        'calendar_oauth_failed',
        expect.objectContaining({ distinct_id: 'unknown' })
      );
    });

    it('SHAPE 1: an unallowlisted provider from the unverified state never reaches the redirect Location (Finding 2)', async () => {
      mockReadStatePayloadUnverified.mockReturnValue({
        expertProfileId: EXPERT_UUID,
        provider: '"><script>alert(1)</script>',
      });
      const res = await injectCallback({ error: 'access_denied', state: 'garbage' });
      expect(res.headers.location).not.toContain('script');
      expect(res.headers.location).not.toContain('calendar_provider=');
    });

    // ── Shape 2: endUserAccountId present ─────────────────────────

    it('SHAPE 2: happy path persists, provisions, rebuilds availability, and redirects connected', async () => {
      mockVerifyConnectState.mockReturnValue({
        expertProfileId: EXPERT_UUID,
        provider: 'google',
        nonce: VALID_NONCE,
      });
      mockPersistApirocConnection.mockResolvedValue({ id: 'conn-1' });
      mockProvisionConnection.mockResolvedValue('ACTIVE');

      const res = await injectCallback(
        { endUserAccountId: 'eua-1', state: 'valid-state' },
        nonceCookieHeader()
      );

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain('calendar_connected=true');
      expect(res.headers.location).toContain('calendar_status=connected');
      // BAL-396 fix round, Finding 4 — the success redirect now carries the provider too, so
      // apps/web can recover it even when the fresh connection has zero sub-calendars yet.
      expect(res.headers.location).toContain('calendar_provider=google');
      expect(res.headers.location).toContain('https://app.balo.test');
      expect(mockPersistApirocConnection).toHaveBeenCalledWith({
        expertProfileId: EXPERT_UUID,
        provider: 'google',
        endUserAccountId: 'eua-1',
      });
      expect(mockEnqueueAvailabilityCacheRebuild).toHaveBeenCalledWith(
        EXPERT_UUID,
        expect.anything()
      );
      // BAL-468 §8.4 — force: true covers both first connect (a no-op — nothing to renew) and
      // reconnect (replaces every canonical subscription rather than trusting a vendor channel
      // that may have died silently during a revoke).
      expect(mockEnqueueSubscriptionReconcile).toHaveBeenCalledWith(
        'conn-1',
        { force: true },
        expect.anything()
      );
    });

    it('SHAPE 2: clears the CSRF cookie on success — the nonce becomes single-use (Finding 1)', async () => {
      mockVerifyConnectState.mockReturnValue({
        expertProfileId: EXPERT_UUID,
        provider: 'google',
        nonce: VALID_NONCE,
      });
      mockPersistApirocConnection.mockResolvedValue({ id: 'conn-1' });
      mockProvisionConnection.mockResolvedValue('ACTIVE');

      const res = await injectCallback(
        { endUserAccountId: 'eua-1', state: 'valid-state' },
        nonceCookieHeader()
      );

      // BAL-396 fix round 2, Finding 5 — the trusted state names 'google', so only that
      // provider's cookie is cleared.
      const setCookie = setCookieHeaders(res);
      expect(setCookie).toHaveLength(1);
      expect(setCookie[0]).toContain(`${calendarConnectNonceCookieName('google')}=;`);
      expect(setCookie[0]).toContain('Max-Age=0');
    });

    it('SHAPE 2: SYNC_PENDING provisioning still redirects success with the sync_pending status', async () => {
      mockVerifyConnectState.mockReturnValue({
        expertProfileId: EXPERT_UUID,
        provider: 'google',
        nonce: VALID_NONCE,
      });
      mockPersistApirocConnection.mockResolvedValue({ id: 'conn-1' });
      mockProvisionConnection.mockResolvedValue('SYNC_PENDING');

      const res = await injectCallback(
        { endUserAccountId: 'eua-1', state: 'valid-state' },
        nonceCookieHeader()
      );

      expect(res.headers.location).toContain('calendar_status=sync_pending');
      // BAL-468 §8.4 — a SYNC_PENDING connection has no sub-calendars yet, so there is
      // nothing to subscribe; the reconcile enqueue is gated on ACTIVE only.
      expect(mockEnqueueSubscriptionReconcile).not.toHaveBeenCalled();
    });

    it('SHAPE 2: an expired state redirects state_expired without calling the connection services', async () => {
      mockVerifyConnectState.mockImplementation(() => {
        throw new Error('State has expired');
      });

      const res = await injectCallback({ endUserAccountId: 'eua-1', state: 'expired-state' });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain('calendar_error=state_expired');
      expect(mockPersistApirocConnection).not.toHaveBeenCalled();
    });

    it('SHAPE 2: a tampered signature redirects invalid_state', async () => {
      mockVerifyConnectState.mockImplementation(() => {
        throw new Error('Invalid state signature');
      });

      const res = await injectCallback({ endUserAccountId: 'eua-1', state: 'bad-state' });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain('calendar_error=invalid_state');
    });

    it('SHAPE 2: a post-verification failure (e.g. provisioning throws) redirects callback_failed', async () => {
      mockVerifyConnectState.mockReturnValue({
        expertProfileId: EXPERT_UUID,
        provider: 'google',
        nonce: VALID_NONCE,
      });
      mockPersistApirocConnection.mockRejectedValue(new Error('db unreachable'));

      const res = await injectCallback(
        { endUserAccountId: 'eua-1', state: 'valid-state' },
        nonceCookieHeader()
      );

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain('calendar_error=callback_failed');
      expect(res.headers.location).toContain('calendar_provider=google');
    });

    // ── BAL-396 fix round, Finding 1 — the CSRF binding check itself ────────────────────

    describe('CSRF nonce binding', () => {
      it('MISSING cookie: redirects state_csrf_mismatch and persists nothing', async () => {
        mockVerifyConnectState.mockReturnValue({
          expertProfileId: EXPERT_UUID,
          provider: 'google',
          nonce: VALID_NONCE,
        });

        const res = await injectCallback({ endUserAccountId: 'eua-1', state: 'valid-state' });

        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toContain('calendar_error=state_csrf_mismatch');
        expect(mockPersistApirocConnection).not.toHaveBeenCalled();
        expect(trackServer).toHaveBeenCalledWith('calendar_oauth_failed', {
          error_code: 'state_csrf_mismatch',
          provider: 'google',
          distinct_id: EXPERT_UUID,
        });
      });

      it('MISMATCHED nonce (the exploit shape — attacker mints a state for their own profile, victim completes it): redirects state_csrf_mismatch and persists nothing', async () => {
        mockVerifyConnectState.mockReturnValue({
          expertProfileId: EXPERT_UUID,
          provider: 'google',
          nonce: VALID_NONCE,
        });

        const res = await injectCallback(
          { endUserAccountId: 'eua-1', state: 'valid-state' },
          nonceCookieHeader('a-completely-different-nonce')
        );

        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toContain('calendar_error=state_csrf_mismatch');
        expect(mockPersistApirocConnection).not.toHaveBeenCalled();
      });

      it('REPLAY: a second callback for the same state, after the first response already cleared the cookie, also fails closed', async () => {
        mockVerifyConnectState.mockReturnValue({
          expertProfileId: EXPERT_UUID,
          provider: 'google',
          nonce: VALID_NONCE,
        });
        mockPersistApirocConnection.mockResolvedValue({ id: 'conn-1' });
        mockProvisionConnection.mockResolvedValue('ACTIVE');

        const first = await injectCallback(
          { endUserAccountId: 'eua-1', state: 'valid-state' },
          nonceCookieHeader()
        );
        expect(first.statusCode).toBe(302);
        expect(first.headers.location).toContain('calendar_connected=true');
        expect(mockPersistApirocConnection).toHaveBeenCalledTimes(1);
        // The response that just completed the flow told the browser to drop the cookie —
        // a genuine second visit (bookmark, back-button resubmit, network retry) arrives
        // with no Cookie header at all, exactly like the "missing cookie" case.
        expect(first.headers['set-cookie']).toContain('Max-Age=0');

        const replay = await injectCallback({ endUserAccountId: 'eua-1', state: 'valid-state' });

        expect(replay.statusCode).toBe(302);
        expect(replay.headers.location).toContain('calendar_error=state_csrf_mismatch');
        // Still exactly one persist — the replay never reached the persistence branch.
        expect(mockPersistApirocConnection).toHaveBeenCalledTimes(1);
      });
    });
  });
});
