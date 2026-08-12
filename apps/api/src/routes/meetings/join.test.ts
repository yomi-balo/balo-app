import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockJoinAsMember, mockJoinAsGuest, mockClaimLobbyPlace, mockCheckRateLimit } = vi.hoisted(
  () => ({
    mockJoinAsMember: vi.fn(),
    mockJoinAsGuest: vi.fn(),
    mockClaimLobbyPlace: vi.fn(),
    mockCheckRateLimit: vi.fn(),
  })
);

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../lib/require-auth.js', () => ({
  requireAuth: async (request: { userId?: string; headers: Record<string, unknown> }) => {
    // Mirrors the real preHandler closely enough to exercise the 401 branch.
    if (typeof request.headers.authorization !== 'string') return;
    request.userId = USER_ID;
  },
}));
vi.mock('../../services/meetings/join-meeting.js', () => ({
  joinMeetingAsMember: mockJoinAsMember,
  joinMeetingAsGuest: mockJoinAsGuest,
  claimLobbyPlace: mockClaimLobbyPlace,
}));
// ⚠ SPREADS THE REAL MODULE. A `() => ({ checkRateLimit })` factory silently drops
// `RATE_LIMIT_DEADLINE_MS`, and `setTimeout(fn, undefined)` fires on the next tick — timing
// out every request in this file for a reason that looks nothing like the cause.
vi.mock('../../lib/rate-limiter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/rate-limiter.js')>()),
  checkRateLimit: mockCheckRateLimit,
}));
vi.mock('../../lib/redis.js', () => ({ getRedis: () => ({}) }));
// ⚠ `./join.schema.js`, `../../lib/route-helpers.js` and `../../lib/with-deadline.js` are
// DELIBERATELY NOT MOCKED. The real Zod boundary is what the `400` rows assert (and its
// ABSENCE of a `party` / `isOwner` key is a security property), and the real deadline is what
// makes the Redis-outage row meaningful.

import Fastify, {
  type FastifyInstance,
  type InjectOptions,
  type LightMyRequestResponse,
} from 'fastify';
import { meetingJoinRoutes } from './join.js';

const USER_ID = '55555555-5555-4555-8555-555555555555';
const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const OTHER_MEETING_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const AUTH_HEADERS = { authorization: 'Bearer test-token' };

const JOIN_URL = `/meetings/${MEETING_ID}/join`;
const LOBBY_URL = `/meetings/${MEETING_ID}/lobby`;
const GUEST_JOIN_URL = `/meetings/${MEETING_ID}/guest-join`;

const RAW_TOKEN = 'z'.repeat(43);

/**
 * ⚠ THE STATUS TABLE, RESTATED INDEPENDENTLY. `JOIN_ERROR_STATUS` is module-private, so this
 * is a separate statement of the mapping rather than a re-import of the thing under test. A
 * silent status change breaks callers' retry logic without breaking a type.
 */
const ERROR_STATUS: ReadonlyArray<{ code: string; status: number }> = [
  { code: 'meeting_not_found', status: 404 },
  { code: 'meeting_not_open_for_join', status: 409 },
  { code: 'meeting_not_provisioned', status: 409 },
  { code: 'meeting_token_unavailable', status: 503 },
];

function grant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    roomUrl: 'https://balo.daily.co/balo-0f7b1c2d3e4f4a5b8c9d0e1f2a3b4c5d',
    token: 'daily.jwt.value',
    isOwner: false,
    expiresAt: '2026-09-02T11:00:00.000Z',
    participantId: 'u555555555555455585555555555555555',
    ...overrides,
  };
}

describe('meeting join routes (BAL-132)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    // ⚠ THE PRODUCTION ERROR HANDLER, RESTATED — see `guests.test.ts`. A bare Fastify
    // instance echoes `error.message` into the body, which would assert a leak production
    // does not have.
    app.setErrorHandler((_error, _request, reply) => {
      reply.status(500).send({ error: 'Internal Server Error' });
    });
    await app.register(meetingJoinRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({ allowed: true, current: 1, ttlSeconds: 3600 });
    mockJoinAsMember.mockResolvedValue({ ok: true, grant: grant() });
    mockJoinAsGuest.mockResolvedValue({ ok: true, state: 'admitted', grant: grant() });
    mockClaimLobbyPlace.mockResolvedValue({ ok: true, lobbyToken: RAW_TOKEN });
  });

  /** One typed entry point to `inject` — keeps the promise overload selected. */
  async function call(opts: InjectOptions): Promise<LightMyRequestResponse> {
    return app.inject(opts);
  }

  // ── AUTHENTICATION ──────────────────────────────────────────────────────────────────

  describe('⚠⚠ which routes are PUBLIC — the test that catches a helpful `requireAuth`', () => {
    it('POST /join REQUIRES a Bearer — 401 without one', async () => {
      const res = await call({ method: 'POST', url: JOIN_URL });

      expect(res.statusCode).toBe(401);
      expect(mockJoinAsMember).not.toHaveBeenCalled();
    });

    it('⚠ POST /lobby is PUBLIC — it must NOT 401 without a Bearer', async () => {
      // An anonymous visitor has no account BY DEFINITION; that is what the queue is for.
      const res = await call({
        method: 'POST',
        url: LOBBY_URL,
        payload: { name: 'Sam Rivera', email: 'sam@cloudpeak.example' },
      });

      expect(res.statusCode).not.toBe(401);
      expect(res.statusCode).toBe(201);
    });

    it('⚠ POST /guest-join is PUBLIC — it must NOT 401 without a Bearer', async () => {
      // The TOKEN is the credential; a guest has no WorkOS session to send a Bearer from.
      const res = await call({
        method: 'POST',
        url: GUEST_JOIN_URL,
        payload: { guestToken: RAW_TOKEN },
      });

      expect(res.statusCode).not.toBe(401);
      expect(res.statusCode).toBe(200);
    });
  });

  // ── THE MEMBER ARM ──────────────────────────────────────────────────────────────────

  describe('POST /meetings/:meetingId/join', () => {
    it('answers 200 with the grant', async () => {
      mockJoinAsMember.mockResolvedValue({ ok: true, grant: grant({ isOwner: true }) });

      const res = await call({ method: 'POST', url: JOIN_URL, headers: AUTH_HEADERS });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(grant({ isOwner: true }));
      expect(mockJoinAsMember).toHaveBeenCalledWith({ meetingId: MEETING_ID, userId: USER_ID });
    });

    it.each(ERROR_STATUS)('maps `$code` to $status', async ({ code, status }) => {
      mockJoinAsMember.mockResolvedValue({ ok: false, code });

      const res = await call({ method: 'POST', url: JOIN_URL, headers: AUTH_HEADERS });

      expect(res.statusCode).toBe(status);
      expect(res.json()).toEqual({ error: code });
    });

    it('answers 400 for a non-uuid meeting id', async () => {
      const res = await call({
        method: 'POST',
        url: '/meetings/not-a-uuid/join',
        headers: AUTH_HEADERS,
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_request' });
      expect(mockJoinAsMember).not.toHaveBeenCalled();
    });

    it('⚠ is NOT rate-limited — a member re-joining their own call must not be throttled', async () => {
      await call({ method: 'POST', url: JOIN_URL, headers: AUTH_HEADERS });

      expect(mockCheckRateLimit).not.toHaveBeenCalled();
    });
  });

  // ── THE LOBBY ───────────────────────────────────────────────────────────────────────

  describe('POST /meetings/:meetingId/lobby', () => {
    const validBody = { name: 'Sam Rivera', email: 'sam@cloudpeak.example' };

    it('answers 201 with `waiting` and the lobby token', async () => {
      const res = await call({ method: 'POST', url: LOBBY_URL, payload: validBody });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ state: 'waiting', lobbyToken: RAW_TOKEN });
    });

    it.each([
      ['a missing name', { email: 'sam@cloudpeak.example' }],
      ['an empty name', { name: '   ', email: 'sam@cloudpeak.example' }],
      ['a missing email', { name: 'Sam' }],
      ['a malformed email', { name: 'Sam', email: 'not-an-email' }],
      ['an over-long name', { name: 'x'.repeat(161), email: 'sam@cloudpeak.example' }],
      ['an over-long email', { name: 'Sam', email: `${'x'.repeat(250)}@x.example` }],
    ])('answers 400 for %s', async (_label, payload) => {
      const res = await call({ method: 'POST', url: LOBBY_URL, payload });

      expect(res.statusCode).toBe(400);
      expect(mockClaimLobbyPlace).not.toHaveBeenCalled();
    });

    it('⚠ STRIPS a client-supplied `party` — the schema has no key for it', async () => {
      // Zod's default object behaviour strips unknown keys, and THAT is what makes it
      // structurally impossible for a visitor to declare themselves expert-side.
      await call({
        method: 'POST',
        url: LOBBY_URL,
        payload: { ...validBody, party: 'expert', accessScope: 'engagement', isOwner: true },
      });

      expect(mockClaimLobbyPlace).toHaveBeenCalledWith({
        meetingId: MEETING_ID,
        name: 'Sam Rivera',
        email: 'sam@cloudpeak.example',
      });
    });

    it('validates BEFORE consuming a rate-limit window', async () => {
      await call({ method: 'POST', url: LOBBY_URL, payload: { name: 'Sam' } });

      expect(mockCheckRateLimit).not.toHaveBeenCalled();
    });

    it('consumes a per-visitor, a per-meeting-visitor AND a per-peer window', async () => {
      await call({ method: 'POST', url: LOBBY_URL, payload: validBody });

      expect(mockCheckRateLimit).toHaveBeenCalledTimes(3);
      const prefixes = mockCheckRateLimit.mock.calls.map(
        (args) => (args[1] as { keyPrefix: string }).keyPrefix
      );
      // ⚠ PER-VISITOR WINDOWS FIRST, THE PEER BACKSTOP LAST — so an abuser is told about their
      // OWN limit rather than about the platform-wide one, which would leak how much aggregate
      // headroom is left.
      expect(prefixes).toEqual([
        'ratelimit:meeting-lobby:visitor',
        'ratelimit:meeting-lobby:meeting-visitor',
        'ratelimit:meeting-lobby:peer',
      ]);
    });

    /**
     * ⚠⚠ THE KEY MATTERS MORE THAN THE NUMBER. Every real lobby request arrives as a
     * server-to-server fetch from `apps/web`'s Server Action, so `request.ip` is the WEB TIER's
     * egress — identical for every guest on the planet. Keyed on that, the "per-IP" windows
     * were ONE platform-wide bucket.
     */
    describe('⚠⚠ the rate-limit IDENTITY (the forwarded client ip)', () => {
      /** The identifier each window was keyed on, in call order. */
      function identifiers(): string[] {
        return mockCheckRateLimit.mock.calls.map((args) => args[2] as string);
      }

      it('keys the per-visitor window on the FORWARDED address, not the peer alone', async () => {
        await call({
          method: 'POST',
          url: LOBBY_URL,
          payload: validBody,
          headers: { 'x-balo-client-ip': '203.0.113.7' },
        });

        const [visitorKey] = identifiers();
        expect(visitorKey).toContain('203.0.113.7');
      });

      it('⚠⚠ the key is COMPOSITE `peer|client`, NEVER `client` alone — that is what stops FRAMING', async () => {
        // The header is a CLAIM, not a fact: these routes are public by design and carry no
        // internal secret to authenticate it with. Because a legitimate visitor's bucket is
        // `<web-tier-egress>|<their-ip>`, an attacker calling the api directly has a different
        // PEER, so every key they can construct is disjoint from every key a real visitor uses.
        // They can only ever exhaust their own.
        await call({
          method: 'POST',
          url: LOBBY_URL,
          payload: validBody,
          headers: { 'x-balo-client-ip': '203.0.113.7' },
        });

        const [visitorKey, , peerKey] = identifiers();
        expect(visitorKey).toBe(`${peerKey}|203.0.113.7`);
        expect(visitorKey).not.toBe('203.0.113.7');
      });

      it('⚠ the PEER window is keyed on the peer ALONE — the one window a spoofer cannot escape', async () => {
        await call({
          method: 'POST',
          url: LOBBY_URL,
          payload: validBody,
          headers: { 'x-balo-client-ip': '203.0.113.7' },
        });

        const [, , peerKey] = identifiers();
        expect(peerKey).not.toContain('203.0.113.7');
      });

      it('⚠ REJECTS a non-IP claim rather than making it Redis key material', async () => {
        await call({
          method: 'POST',
          url: LOBBY_URL,
          payload: validBody,
          headers: { 'x-balo-client-ip': 'not-an-ip; DROP TABLE' },
        });

        const [visitorKey, , peerKey] = identifiers();
        // Falls back to the peer on BOTH halves — the claim never reaches the key.
        expect(visitorKey).toBe(`${peerKey}|${peerKey}`);
        expect(visitorKey).not.toContain('DROP TABLE');
      });

      it('accepts an IPv6 claim', async () => {
        await call({
          method: 'POST',
          url: LOBBY_URL,
          payload: validBody,
          headers: { 'x-balo-client-ip': '2001:db8::1' },
        });

        expect(identifiers()[0]).toContain('2001:db8::1');
      });

      it('falls back to the peer when the header is absent', async () => {
        await call({ method: 'POST', url: LOBBY_URL, payload: validBody });

        const [visitorKey, , peerKey] = identifiers();
        expect(visitorKey).toBe(`${peerKey}|${peerKey}`);
      });

      it('⚠ the per-meeting window is keyed on (meeting, VISITOR) — never the meeting alone', async () => {
        // A bare `meetingId` key was an AVAILABILITY LEVER POINTED AT THE HOST: anyone who
        // knew a meeting id could burn its window in seconds and lock out every legitimate
        // guest for the following hour.
        await call({
          method: 'POST',
          url: LOBBY_URL,
          payload: validBody,
          headers: { 'x-balo-client-ip': '203.0.113.7' },
        });

        const [visitorKey, meetingVisitorKey] = identifiers();
        expect(meetingVisitorKey).toBe(`${MEETING_ID}|${visitorKey}`);
        expect(meetingVisitorKey).not.toBe(MEETING_ID);
      });

      it('two different visitors on ONE meeting get DIFFERENT keys', async () => {
        await call({
          method: 'POST',
          url: LOBBY_URL,
          payload: validBody,
          headers: { 'x-balo-client-ip': '203.0.113.7' },
        });
        const first = identifiers();

        mockCheckRateLimit.mockClear();
        await call({
          method: 'POST',
          url: LOBBY_URL,
          payload: validBody,
          headers: { 'x-balo-client-ip': '198.51.100.4' },
        });
        const second = identifiers();

        expect(first[0]).not.toBe(second[0]);
        expect(first[1]).not.toBe(second[1]);
        // ⚠ …but the PEER backstop is deliberately shared: it bounds aggregate volume.
        expect(first[2]).toBe(second[2]);
      });
    });

    it('answers 429 with Retry-After when a window is exhausted', async () => {
      mockCheckRateLimit.mockResolvedValue({ allowed: false, current: 11, ttlSeconds: 1800 });

      const res = await call({ method: 'POST', url: LOBBY_URL, payload: validBody });

      expect(res.statusCode).toBe(429);
      expect(res.headers['retry-after']).toBe('1800');
      expect(mockClaimLobbyPlace).not.toHaveBeenCalled();
    });

    it('⚠ FAILS CLOSED to 503 when Redis is down — never "carry on unlimited"', async () => {
      mockCheckRateLimit.mockRejectedValue(new Error('redis unreachable'));

      const res = await call({ method: 'POST', url: LOBBY_URL, payload: validBody });

      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'rate_limit_unavailable' });
      expect(mockClaimLobbyPlace).not.toHaveBeenCalled();
    });

    it.each(ERROR_STATUS)('maps `$code` to $status', async ({ code, status }) => {
      mockClaimLobbyPlace.mockResolvedValue({ ok: false, code });

      const res = await call({ method: 'POST', url: LOBBY_URL, payload: validBody });

      expect(res.statusCode).toBe(status);
      expect(res.json()).toEqual({ error: code });
    });
  });

  // ── THE GUEST ARM ───────────────────────────────────────────────────────────────────

  describe('POST /meetings/:meetingId/guest-join', () => {
    const validBody = { guestToken: RAW_TOKEN };

    it('answers 200 `admitted` with the grant', async () => {
      const res = await call({ method: 'POST', url: GUEST_JOIN_URL, payload: validBody });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ state: 'admitted', grant: grant() });
    });

    it('⚠ answers 200 `waiting` with NO grant while pending', async () => {
      mockJoinAsGuest.mockResolvedValue({ ok: true, state: 'waiting' });

      const res = await call({ method: 'POST', url: GUEST_JOIN_URL, payload: validBody });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ state: 'waiting' });
      expect(res.body).not.toContain('token');
    });

    it.each([
      ['a missing token', {}],
      ['a too-short token', { guestToken: 'abc' }],
      ['an over-long token', { guestToken: 'x'.repeat(201) }],
    ])('answers 400 for %s', async (_label, payload) => {
      const res = await call({ method: 'POST', url: GUEST_JOIN_URL, payload });

      expect(res.statusCode).toBe(400);
      expect(mockJoinAsGuest).not.toHaveBeenCalled();
    });

    it('consumes a generous PER-VISITOR window plus a peer backstop — it is polled every 5s', async () => {
      await call({ method: 'POST', url: GUEST_JOIN_URL, payload: validBody });

      expect(mockCheckRateLimit).toHaveBeenCalledTimes(2);
      const prefixes = mockCheckRateLimit.mock.calls.map(
        (args) => (args[1] as { keyPrefix: string }).keyPrefix
      );
      expect(prefixes).toEqual([
        'ratelimit:meeting-guest-join:visitor',
        'ratelimit:meeting-guest-join:peer',
      ]);
    });

    it('⚠⚠ the poll window is PER VISITOR — keyed on the peer alone, 3 waiting guests broke it', async () => {
      // At the documented cadence (~264 requests/hour each) three concurrent waiting guests
      // exceeded the 600/hour window between them. That is a functional break at trivial load,
      // not merely a weak control.
      await call({
        method: 'POST',
        url: GUEST_JOIN_URL,
        payload: validBody,
        headers: { 'x-balo-client-ip': '203.0.113.7' },
      });
      const first = mockCheckRateLimit.mock.calls.map((args) => args[2] as string);

      mockCheckRateLimit.mockClear();
      await call({
        method: 'POST',
        url: GUEST_JOIN_URL,
        payload: validBody,
        headers: { 'x-balo-client-ip': '198.51.100.4' },
      });
      const second = mockCheckRateLimit.mock.calls.map((args) => args[2] as string);

      expect(first[0]).not.toBe(second[0]);
      expect(first[0]).toContain('203.0.113.7');
      expect(second[0]).toContain('198.51.100.4');
    });

    it.each(ERROR_STATUS)('maps `$code` to $status', async ({ code, status }) => {
      mockJoinAsGuest.mockResolvedValue({ ok: false, code });

      const res = await call({ method: 'POST', url: GUEST_JOIN_URL, payload: validBody });

      expect(res.statusCode).toBe(status);
      expect(res.json()).toEqual({ error: code });
    });
  });

  // ── THE NON-LEAKING PROPERTY ────────────────────────────────────────────────────────

  describe('⚠⚠ no response body leaks a uuid, an address or vendor text', () => {
    it.each(ERROR_STATUS)('the `$code` body is exactly the literal', async ({ code }) => {
      mockJoinAsMember.mockResolvedValue({ ok: false, code });
      mockJoinAsGuest.mockResolvedValue({ ok: false, code });
      mockClaimLobbyPlace.mockResolvedValue({ ok: false, code });

      const responses = await Promise.all([
        call({ method: 'POST', url: JOIN_URL, headers: AUTH_HEADERS }),
        call({ method: 'POST', url: GUEST_JOIN_URL, payload: { guestToken: RAW_TOKEN } }),
        call({
          method: 'POST',
          url: LOBBY_URL,
          payload: { name: 'Sam', email: 'sam@cloudpeak.example' },
        }),
      ]);

      for (const res of responses) {
        expect(res.body).not.toContain(MEETING_ID);
        expect(res.body).not.toContain(USER_ID);
        expect(res.body).not.toContain('sam@cloudpeak.example');
        expect(res.json()).toEqual({ error: code });
      }
    });

    it('⚠ an UNKNOWN meeting and a CROSS-TENANT meeting are BYTE-IDENTICAL', async () => {
      // Both collapse to `meeting_not_found` in the service; if the route ever added a
      // distinguishing field, this is where it would show up.
      mockJoinAsMember.mockResolvedValue({ ok: false, code: 'meeting_not_found' });

      const unknown = await call({ method: 'POST', url: JOIN_URL, headers: AUTH_HEADERS });
      const crossTenant = await call({
        method: 'POST',
        url: `/meetings/${OTHER_MEETING_ID}/join`,
        headers: AUTH_HEADERS,
      });

      expect(unknown.statusCode).toBe(crossTenant.statusCode);
      expect(unknown.body).toBe(crossTenant.body);
    });

    it('does not echo an error message when the service throws', async () => {
      mockJoinAsMember.mockRejectedValue(
        new Error('daily said: room balo-0f7b1c2d does not exist')
      );

      const res = await call({ method: 'POST', url: JOIN_URL, headers: AUTH_HEADERS });

      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain('balo-0f7b1c2d');
      expect(res.json()).toEqual({ error: 'Internal Server Error' });
    });
  });
});
