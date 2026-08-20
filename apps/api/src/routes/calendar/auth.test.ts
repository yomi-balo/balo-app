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
  mockEndUserAccountsGet,
  mockEnqueueSubscriptionReconcile,
} = vi.hoisted(() => ({
  mockBuildApirocAuthorizeUrl: vi.fn(),
  mockSignConnectState: vi.fn(),
  mockVerifyConnectState: vi.fn(),
  mockReadStatePayloadUnverified: vi.fn(),
  mockPersistApirocConnection: vi.fn(),
  mockProvisionConnection: vi.fn(),
  mockEnqueueAvailabilityCacheRebuild: vi.fn(),
  mockEndUserAccountsGet: vi.fn(),
  mockEnqueueSubscriptionReconcile: vi.fn(),
}));

// BAL-397 fix round — the callback now resolves the browser-supplied `endUserAccountId`
// against the HMAC-trusted `expertProfileId` via `endUserAccounts.get`, so the SDK boundary is
// a live collaborator of this route (it was inert before). `callApiroc` is passed through
// verbatim: its normalisation is `lib/apiroc/errors.test.ts`'s subject, not this file's.
vi.mock('../../lib/apiroc/index.js', () => ({
  buildApirocAuthorizeUrl: mockBuildApirocAuthorizeUrl,
  getApirocClient: () => ({ endUserAccounts: { get: mockEndUserAccountsGet } }),
  callApiroc: <T>(_operation: string, fn: () => Promise<T>): Promise<T> => fn(),
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
    // BAL-397 fix round — default the vendor-account ownership lookup to the HAPPY shape (the
    // account really does carry this expert's id as its `externalId`), so every pre-existing
    // SHAPE 2 fixture below still exercises what it was written to exercise. The binding's own
    // failure modes are driven explicitly in the `vendor-account ownership binding` block.
    mockEndUserAccountsGet.mockResolvedValue({ id: 'eua-1', externalId: EXPERT_UUID });
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
      // BAL-397 fix round — `distinct_id` is 'unknown' on EVERY unverified arm, even when the
      // state happens to carry a well-formed id: there is no signature check here, so the id
      // is browser-authored. `provider` still rides along because it is laundered through the
      // `toCalendarEventProvider` allowlist first.
      expect(trackServer).toHaveBeenCalledWith('calendar_oauth_failed', {
        error_code: 'o365_admin_approval',
        provider: 'microsoft',
        distinct_id: 'unknown',
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

    // BAL-397 fix round (security WARNING) — unauthenticated analytics/identity injection.
    it('SHAPE 1: a forged expertProfileId in the UNVERIFIED state never reaches PostHog as distinct_id', async () => {
      mockReadStatePayloadUnverified.mockReturnValue({
        expertProfileId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        provider: 'google',
      });

      await injectCallback({ error: 'access_denied', state: 'attacker-authored-state' });

      expect(trackServer).toHaveBeenCalledWith(
        'calendar_oauth_failed',
        expect.objectContaining({ distinct_id: 'unknown' })
      );
      expect(trackServer).not.toHaveBeenCalledWith(
        'calendar_oauth_failed',
        expect.objectContaining({ distinct_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' })
      );
    });

    // BAL-397 fix round (security WARNING) — the public route's string params are bounded, so
    // an unauthenticated caller cannot push unbounded text into Axiom/PostHog.
    it('rejects an over-long error_description instead of logging it', async () => {
      const res = await injectCallback({ error: 'x', error_description: 'a'.repeat(5000) });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain('calendar_error=invalid_callback');
      expect(mockPersistApirocConnection).not.toHaveBeenCalled();
    });

    it('rejects an over-long endUserAccountId instead of persisting it', async () => {
      const res = await injectCallback(
        { endUserAccountId: 'a'.repeat(500), state: 'valid-state' },
        nonceCookieHeader()
      );

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain('calendar_error=invalid_callback');
      expect(mockPersistApirocConnection).not.toHaveBeenCalled();
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
      // BAL-397 §13.2 — the real DB vocabulary rides the wire now, not the retired
      // `connected`/`sync_pending` strings.
      expect(res.headers.location).toContain('calendar_status=ACTIVE');
      // BAL-397 §13.1 — the callback lands on the Schedule tab (where the calendar section
      // actually renders), not the dead `?tab=calendar`.
      expect(res.headers.location).toContain('tab=schedule');
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

      expect(res.headers.location).toContain('calendar_status=SYNC_PENDING');
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

    // ── BAL-397 fix round — the vendor-account ownership binding (security CRITICAL) ─────
    //
    // THE ATTACK THESE PIN: an authenticated expert starts a legitimate connect for their OWN
    // profile (so `state` verifies and their own nonce cookie matches), never visits the
    // vendor, and instead hits the callback directly with ANOTHER expert's `endUserAccountId`.
    // Before this fix that repointed their connection row at the victim's Apiroc account —
    // reading the victim's free/busy and writing Balo's consultation events into the victim's
    // calendar. `verifyConnectState` + the nonce cookie both PASS in every case below; the
    // ownership check is the only thing standing between the request and persistence.
    describe('vendor-account ownership binding', () => {
      const VICTIM_UUID = '11111111-2222-4333-8444-555555555555';

      beforeEach(() => {
        mockVerifyConnectState.mockReturnValue({
          expertProfileId: EXPERT_UUID,
          provider: 'google',
          nonce: VALID_NONCE,
        });
        mockPersistApirocConnection.mockResolvedValue({ id: 'conn-1' });
        mockProvisionConnection.mockResolvedValue('ACTIVE');
      });

      it('an endUserAccountId belonging to ANOTHER expert persists nothing and redirects down the opaque path', async () => {
        mockEndUserAccountsGet.mockResolvedValue({
          id: 'victim-eua',
          externalId: VICTIM_UUID,
        });

        const res = await injectCallback(
          { endUserAccountId: 'victim-eua', state: 'valid-state' },
          nonceCookieHeader()
        );

        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toContain('calendar_error=state_csrf_mismatch');
        expect(res.headers.location).not.toContain('calendar_connected=true');
        expect(mockPersistApirocConnection).not.toHaveBeenCalled();
        expect(mockProvisionConnection).not.toHaveBeenCalled();
        expect(mockEnqueueAvailabilityCacheRebuild).not.toHaveBeenCalled();
      });

      it('reuses state_csrf_mismatch rather than minting a distinct code — no existence oracle for account ids', async () => {
        // An UNKNOWN id (the lookup 404s) and a REAL id owned by someone else must be
        // indistinguishable to the browser, or the endpoint enumerates valid account ids.
        mockEndUserAccountsGet.mockRejectedValueOnce(new Error('End user account not found'));
        const unknownId = await injectCallback(
          { endUserAccountId: 'does-not-exist', state: 'valid-state' },
          nonceCookieHeader()
        );

        mockEndUserAccountsGet.mockResolvedValueOnce({ id: 'victim-eua', externalId: VICTIM_UUID });
        const someoneElses = await injectCallback(
          { endUserAccountId: 'victim-eua', state: 'valid-state' },
          nonceCookieHeader()
        );

        expect(unknownId.headers.location).toBe(someoneElses.headers.location);
        expect(mockPersistApirocConnection).not.toHaveBeenCalled();
      });

      it('FAILS CLOSED when the account lookup itself fails (5xx / network / timeout)', async () => {
        mockEndUserAccountsGet.mockRejectedValue(new Error('socket hang up'));

        const res = await injectCallback(
          { endUserAccountId: 'eua-1', state: 'valid-state' },
          nonceCookieHeader()
        );

        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toContain('calendar_error=state_csrf_mismatch');
        expect(mockPersistApirocConnection).not.toHaveBeenCalled();
      });

      it('FAILS CLOSED on an account with no externalId — Balo did not create it', async () => {
        mockEndUserAccountsGet.mockResolvedValue({ id: 'eua-1', externalId: null });

        const res = await injectCallback(
          { endUserAccountId: 'eua-1', state: 'valid-state' },
          nonceCookieHeader()
        );

        expect(res.headers.location).toContain('calendar_error=state_csrf_mismatch');
        expect(mockPersistApirocConnection).not.toHaveBeenCalled();
      });

      it('resolves the account the CALLBACK named — not one derived from the state', async () => {
        await injectCallback(
          { endUserAccountId: 'eua-from-query', state: 'valid-state' },
          nonceCookieHeader()
        );

        expect(mockEndUserAccountsGet).toHaveBeenCalledWith('eua-from-query');
      });

      it('lets the matching account through to persistence', async () => {
        const res = await injectCallback(
          { endUserAccountId: 'eua-1', state: 'valid-state' },
          nonceCookieHeader()
        );

        expect(res.headers.location).toContain('calendar_connected=true');
        expect(mockPersistApirocConnection).toHaveBeenCalledWith({
          expertProfileId: EXPERT_UUID,
          provider: 'google',
          endUserAccountId: 'eua-1',
        });
      });

      it('never reaches the vendor lookup when the CSRF nonce already failed', async () => {
        // Ordering matters: an unauthenticated-ish caller must not be able to probe the vendor
        // at all until they have proven they started this flow in this browser.
        const res = await injectCallback({ endUserAccountId: 'eua-1', state: 'valid-state' });

        expect(res.headers.location).toContain('calendar_error=state_csrf_mismatch');
        expect(mockEndUserAccountsGet).not.toHaveBeenCalled();
      });
    });
  });
});
