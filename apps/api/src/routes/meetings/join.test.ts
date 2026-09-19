import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockJoinAsMember,
  mockJoinAsGuest,
  mockClaimLobbyPlace,
  mockCheckRateLimit,
  mockRequestLobbyReentryLink,
} = vi.hoisted(() => ({
  mockJoinAsMember: vi.fn(),
  mockJoinAsGuest: vi.fn(),
  mockClaimLobbyPlace: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockRequestLobbyReentryLink: vi.fn(),
}));

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
vi.mock('../../services/meetings/request-lobby-reentry-link.js', () => ({
  requestLobbyReentryLink: mockRequestLobbyReentryLink,
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
// ⚠ BAL-442 — `../../lib/response-floor.js` and `../../lib/recipient-rate-limit-key.js` are
// ALSO NOT MOCKED. The real floor is what the TIMING assertions are about (under fake timers),
// and the real hash is what lets a test compute the fourth window's key independently and
// compare it against what the route actually passed to `checkRateLimit`.

import Fastify, {
  type FastifyInstance,
  type InjectOptions,
  type LightMyRequestResponse,
} from 'fastify';
import { meetingJoinRoutes } from './join.js';
import { LOBBY_REENTRY_RESPONSE_FLOOR_MS } from '../../lib/response-floor.js';

const USER_ID = '55555555-5555-4555-8555-555555555555';
const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const OTHER_MEETING_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const AUTH_HEADERS = { authorization: 'Bearer test-token' };

const JOIN_URL = `/meetings/${MEETING_ID}/join`;
const LOBBY_URL = `/meetings/${MEETING_ID}/lobby`;
const GUEST_JOIN_URL = `/meetings/${MEETING_ID}/guest-join`;
const REENTRY_URL = `/meetings/${MEETING_ID}/lobby/reentry`;

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
    mockRequestLobbyReentryLink.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
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

    it('⚠ POST /lobby/reentry is PUBLIC — it must NOT 401 without a Bearer', async () => {
      // The caller has no account BY DEFINITION — same reasoning as the knock above.
      // ⚠ fix-round (F13) — fake timers so the fixed 400ms floor does not cost a real sleep.
      vi.useFakeTimers();
      const pending = call({
        method: 'POST',
        url: REENTRY_URL,
        payload: { email: 'sam@cloudpeak.example' },
      });
      await vi.advanceTimersByTimeAsync(LOBBY_REENTRY_RESPONSE_FLOOR_MS);
      const res = await pending;

      expect(res.statusCode).not.toBe(401);
      expect(res.statusCode).toBe(202);
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

    /**
     * ⚠⚠ BAL-436 — THE NAME COLUMN IS THE NEIGHBOUR THE CONCEALMENT DOES NOT COVER.
     *
     * `projectGuestForViewer`'s `link` arm strips `email` / `emailDomain` / `accessScope` and
     * refuses the `displayName`-falls-back-to-the-address rule — but `name` is typed by the
     * SAME anonymous visitor and IS rendered: in the queue row, in the `Admit …` / `Deny …`
     * accessible names, and (on a re-send) inside a Balo-branded email. So the sanitiser runs
     * HERE, at the boundary, before `claimLobbyPlace` ever sees the string.
     */
    it('⚠⚠ COLLAPSES A NAME THAT IS AN EMAIL ADDRESS — the service never sees it', async () => {
      await call({
        method: 'POST',
        url: LOBBY_URL,
        payload: { name: 'dana.okoro@northwind.com', email: 'sam@cloudpeak.example' },
      });

      expect(mockClaimLobbyPlace).toHaveBeenCalledWith({
        meetingId: MEETING_ID,
        name: 'Guest',
        email: 'sam@cloudpeak.example',
      });
    });

    it('⚠ STRIPS A "✅ Verified" SUFFIX — the same attack without an `@`', async () => {
      await call({
        method: 'POST',
        url: LOBBY_URL,
        payload: { name: 'Dana Okoro ✅ Verified', email: 'sam@cloudpeak.example' },
      });

      expect(mockClaimLobbyPlace).toHaveBeenCalledWith({
        meetingId: MEETING_ID,
        name: 'Dana Okoro',
        email: 'sam@cloudpeak.example',
      });
    });

    it('⚠ AN EMPTY KNOCK IS STILL A 400 — the collapse is not a way to send nothing', async () => {
      const res = await call({
        method: 'POST',
        url: LOBBY_URL,
        payload: { name: '   ', email: 'sam@cloudpeak.example' },
      });

      expect(res.statusCode).toBe(400);
      expect(mockClaimLobbyPlace).not.toHaveBeenCalled();
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

  // ── THE LOBBY RE-ENTRY ARM (BAL-442) ────────────────────────────────────────────────

  describe('POST /meetings/:meetingId/lobby/reentry', () => {
    const validBody = { email: 'sam@cloudpeak.example' };

    it('answers 202 with { state: "requested" }', async () => {
      // ⚠ fix-round (F13) — fake timers so the fixed 400ms floor does not cost a real sleep.
      vi.useFakeTimers();
      const pending = call({ method: 'POST', url: REENTRY_URL, payload: validBody });
      await vi.advanceTimersByTimeAsync(LOBBY_REENTRY_RESPONSE_FLOOR_MS);
      const res = await pending;

      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ state: 'requested' });
    });

    /**
     * ⚠⚠ TEST #45 — NEUTRALITY. A match response and a miss response must be BYTE-IDENTICAL.
     * `requestLobbyReentryLink` returns `void` regardless of outcome, so this proves the route
     * cannot even construct a distinguishing response.
     *
     * ⚠ fix-round (F3 / SEC-2 / REV-2) — REPAIRED. The original arrangement gave BOTH arms
     * `mockResolvedValue(undefined)` — the identical mock behaviour compared against itself —
     * so `shapes.size === 1` held trivially and this test would still pass with the feature
     * reverted to any constant-response route. The two arms now have MATERIALLY DIFFERENT
     * service behaviour (a match doing 50ms of real work vs a miss resolving immediately, under
     * fake timers), so this proves body+status parity actually survives that difference, not
     * merely that two identical mocks produce identical output.
     */
    it('⚠⚠ NEUTRALITY: match and miss are byte-identical — same status, same body', async () => {
      vi.useFakeTimers();

      // Match-shaped: the service does 50ms of real work (mint + UPDATE + BullMQ enqueue).
      mockRequestLobbyReentryLink.mockImplementationOnce(
        () => new Promise<void>((resolve) => setTimeout(resolve, 50))
      );
      const matchPending = call({ method: 'POST', url: REENTRY_URL, payload: validBody });
      await vi.advanceTimersByTimeAsync(LOBBY_REENTRY_RESPONSE_FLOOR_MS);
      const matchRes = await matchPending;

      // Miss-shaped: the service resolves immediately (one SELECT, no match).
      mockRequestLobbyReentryLink.mockResolvedValueOnce(undefined);
      const missPending = call({ method: 'POST', url: REENTRY_URL, payload: validBody });
      await vi.advanceTimersByTimeAsync(LOBBY_REENTRY_RESPONSE_FLOOR_MS);
      const missRes = await missPending;

      const shapes = new Set([
        JSON.stringify([matchRes.statusCode, matchRes.json()]),
        JSON.stringify([missRes.statusCode, missRes.json()]),
      ]);
      expect(shapes.size).toBe(1);
      expect(matchRes.statusCode).toBe(202);
    });

    /**
     * ⚠⚠ fix-round (F2 / SEC-1 / REV-3) — a throw from the service (the only residual throw
     * source is `rotatePendingLobbyToken`, reached ONLY on the match arm) must still answer the
     * SAME neutral `202`, still padded to the SAME floor — never a `500`, and never faster than
     * a miss. This is the mutation-proof target for the try/catch inside the floor closure.
     */
    it('⚠⚠ a service REJECTION still answers 202, still padded to the floor — never a 500', async () => {
      vi.useFakeTimers();
      mockRequestLobbyReentryLink.mockRejectedValueOnce(new Error('serialization failure'));

      let settled = false;
      const pending = call({ method: 'POST', url: REENTRY_URL, payload: validBody }).then((res) => {
        settled = true;
        return res;
      });

      await vi.advanceTimersByTimeAsync(LOBBY_REENTRY_RESPONSE_FLOOR_MS - 1);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      const res = await pending;
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ state: 'requested' });
    });

    /**
     * ⚠⚠ TEST #46 — TIMING. Under fake timers, a slow (match-shaped) and a fast (miss-shaped)
     * service call must settle at the SAME instant: `LOBBY_REENTRY_RESPONSE_FLOOR_MS`.
     */
    describe('⚠⚠ TIMING — the fixed floor equalises a slow match and a fast miss', () => {
      it('neither arm settles before the floor, and BOTH settle exactly at it', async () => {
        vi.useFakeTimers();

        // The "match" shape: the service takes 50ms of real work.
        mockRequestLobbyReentryLink.mockImplementationOnce(
          () => new Promise<void>((resolve) => setTimeout(resolve, 50))
        );
        let matchSettled = false;
        const matchPending = call({ method: 'POST', url: REENTRY_URL, payload: validBody }).then(
          (res) => {
            matchSettled = true;
            return res;
          }
        );

        await vi.advanceTimersByTimeAsync(LOBBY_REENTRY_RESPONSE_FLOOR_MS - 1);
        expect(matchSettled).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        expect(matchSettled).toBe(true);
        expect((await matchPending).statusCode).toBe(202);
      });

      it('the miss shape (0ms of work) is padded to the SAME floor, not answered immediately', async () => {
        vi.useFakeTimers();

        mockRequestLobbyReentryLink.mockResolvedValueOnce(undefined);
        let missSettled = false;
        const missPending = call({ method: 'POST', url: REENTRY_URL, payload: validBody }).then(
          (res) => {
            missSettled = true;
            return res;
          }
        );

        await vi.advanceTimersByTimeAsync(LOBBY_REENTRY_RESPONSE_FLOOR_MS - 1);
        expect(missSettled).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        expect(missSettled).toBe(true);
        expect((await missPending).statusCode).toBe(202);
      });

      it('the floor constant is pinned to exactly 400ms', () => {
        expect(LOBBY_REENTRY_RESPONSE_FLOOR_MS).toBe(400);
      });
    });

    it.each([
      ['a malformed :meetingId', { url: `/meetings/not-a-uuid/lobby/reentry`, payload: validBody }],
      ['a missing email', { url: REENTRY_URL, payload: {} }],
      ['a malformed email', { url: REENTRY_URL, payload: { email: 'not-an-email' } }],
    ])('answers 400 for %s, and never consumes a rate-limit window', async (_label, opts) => {
      const res = await call({ method: 'POST', ...opts });

      expect(res.statusCode).toBe(400);
      expect(mockCheckRateLimit).not.toHaveBeenCalled();
      expect(mockRequestLobbyReentryLink).not.toHaveBeenCalled();
    });

    it('⚠ STRIPS unknown body keys — the service reaches exactly { meetingId, email }', async () => {
      vi.useFakeTimers();
      const pending = call({
        method: 'POST',
        url: REENTRY_URL,
        payload: { email: 'sam@cloudpeak.example', name: 'x', party: 'expert' },
      });
      await vi.advanceTimersByTimeAsync(LOBBY_REENTRY_RESPONSE_FLOOR_MS);
      await pending;

      expect(mockRequestLobbyReentryLink).toHaveBeenCalledWith({
        meetingId: MEETING_ID,
        email: 'sam@cloudpeak.example',
      });
    });

    it('⚠ the email reaching the service is CANONICAL (trimmed, lower-cased)', async () => {
      vi.useFakeTimers();
      const pending = call({
        method: 'POST',
        url: REENTRY_URL,
        payload: { email: '  SAM@Cloudpeak.EXAMPLE ' },
      });
      await vi.advanceTimersByTimeAsync(LOBBY_REENTRY_RESPONSE_FLOOR_MS);
      await pending;

      expect(mockRequestLobbyReentryLink).toHaveBeenCalledWith({
        meetingId: MEETING_ID,
        email: 'sam@cloudpeak.example',
      });
    });

    it('consumes a per-visitor, a per-meeting-visitor AND a per-peer window, in that order', async () => {
      vi.useFakeTimers();
      const pending = call({ method: 'POST', url: REENTRY_URL, payload: validBody });
      await vi.advanceTimersByTimeAsync(LOBBY_REENTRY_RESPONSE_FLOOR_MS);
      await pending;

      const prefixes = mockCheckRateLimit.mock.calls.map(
        (args) => (args[1] as { keyPrefix: string }).keyPrefix
      );
      expect(prefixes).toEqual([
        'ratelimit:meeting-lobby-reentry:visitor',
        'ratelimit:meeting-lobby-reentry:meeting-visitor',
        'ratelimit:meeting-lobby-reentry:peer',
        'ratelimit:meeting-lobby-reentry:recipient',
      ]);
    });

    it('⚠ every re-entry window prefix DIFFERS from every knock window prefix', async () => {
      vi.useFakeTimers();
      const pending = call({ method: 'POST', url: REENTRY_URL, payload: validBody });
      await vi.advanceTimersByTimeAsync(LOBBY_REENTRY_RESPONSE_FLOOR_MS);
      await pending;

      const prefixes = mockCheckRateLimit.mock.calls.map(
        (args) => (args[1] as { keyPrefix: string }).keyPrefix
      );
      // ⚠ fix-round (F6) — NON-VACUITY GUARD. Without this, an empty `prefixes` array would
      // make the `for` loop below run zero times and the test would pass for the wrong reason.
      expect(prefixes).toHaveLength(4);
      const knockPrefixes = [
        'ratelimit:meeting-lobby:visitor',
        'ratelimit:meeting-lobby:meeting-visitor',
        'ratelimit:meeting-lobby:peer',
      ];
      for (const prefix of prefixes) {
        expect(knockPrefixes).not.toContain(prefix);
      }
    });

    it('⚠⚠ the FOURTH identifier is keyed on `meetingId|sha256(canonicalEmail).slice(0,32)`, and the first three are the visitor triple', async () => {
      vi.useFakeTimers();
      const pending = call({ method: 'POST', url: REENTRY_URL, payload: validBody });
      await vi.advanceTimersByTimeAsync(LOBBY_REENTRY_RESPONSE_FLOOR_MS);
      await pending;

      const identifiers = mockCheckRateLimit.mock.calls.map((args) => args[2] as string);
      expect(identifiers).toHaveLength(4);
      const [visitorKey, meetingVisitorKey, peerKey, recipientKey] = identifiers;
      const expectedHash = createHash('sha256')
        .update('sam@cloudpeak.example')
        .digest('hex')
        .slice(0, 32);

      expect(recipientKey).toBe(`${MEETING_ID}|${expectedHash}`);
      // ⚠ THE PAIR: positive (equals the computed hash) AND negative (never the raw address).
      expect(recipientKey).not.toContain('@');

      // ⚠ fix-round (F6) — plan #50's first three identifiers, previously never asserted
      // (only the fourth was). `visitorIdentity` builds `visitorKey = ${peer}|${client}`; with
      // no `x-balo-client-ip` header, `client === peer`, so `visitorKey` is `peer` doubled.
      expect(peerKey).toBeTruthy();
      expect(visitorKey).toBe(`${peerKey}|${peerKey}`);
      expect(meetingVisitorKey).toBe(`${MEETING_ID}|${visitorKey}`);
    });

    it('⚠⚠ recipient-window EXHAUSTION returns the SAME neutral 202 — never a 429', async () => {
      vi.useFakeTimers();
      // The first three (caller-keyed) windows allow; the fourth (recipient-keyed) denies.
      mockCheckRateLimit
        .mockResolvedValueOnce({ allowed: true, current: 1, ttlSeconds: 3600 })
        .mockResolvedValueOnce({ allowed: true, current: 1, ttlSeconds: 3600 })
        .mockResolvedValueOnce({ allowed: true, current: 1, ttlSeconds: 3600 })
        .mockResolvedValueOnce({ allowed: false, current: 4, ttlSeconds: 900 });

      const pending = call({ method: 'POST', url: REENTRY_URL, payload: validBody });
      await vi.advanceTimersByTimeAsync(LOBBY_REENTRY_RESPONSE_FLOOR_MS);
      const res = await pending;

      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ state: 'requested' });
      expect(mockRequestLobbyReentryLink).not.toHaveBeenCalled();
    });

    it('recipient-window exhaustion is ALSO padded to the floor', async () => {
      vi.useFakeTimers();
      mockCheckRateLimit
        .mockResolvedValueOnce({ allowed: true, current: 1, ttlSeconds: 3600 })
        .mockResolvedValueOnce({ allowed: true, current: 1, ttlSeconds: 3600 })
        .mockResolvedValueOnce({ allowed: true, current: 1, ttlSeconds: 3600 })
        .mockResolvedValueOnce({ allowed: false, current: 4, ttlSeconds: 900 });

      let settled = false;
      const pending = call({ method: 'POST', url: REENTRY_URL, payload: validBody }).then((res) => {
        settled = true;
        return res;
      });

      await vi.advanceTimersByTimeAsync(LOBBY_REENTRY_RESPONSE_FLOOR_MS - 1);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expect((await pending).statusCode).toBe(202);
    });

    it('the three CALLER-keyed windows still answer 429 with Retry-After and cooldownSeconds', async () => {
      mockCheckRateLimit.mockResolvedValue({ allowed: false, current: 6, ttlSeconds: 1200 });

      const res = await call({ method: 'POST', url: REENTRY_URL, payload: validBody });

      expect(res.statusCode).toBe(429);
      expect(res.headers['retry-after']).toBe('1200');
      expect(res.json()).toEqual({ error: 'rate_limited', cooldownSeconds: 1200 });
      expect(mockRequestLobbyReentryLink).not.toHaveBeenCalled();
    });

    it('⚠ Redis outage on the RECIPIENT window → 503, never neutral, never a silent send', async () => {
      mockCheckRateLimit
        .mockResolvedValueOnce({ allowed: true, current: 1, ttlSeconds: 3600 })
        .mockResolvedValueOnce({ allowed: true, current: 1, ttlSeconds: 3600 })
        .mockResolvedValueOnce({ allowed: true, current: 1, ttlSeconds: 3600 })
        .mockRejectedValueOnce(new Error('redis unreachable'));

      const res = await call({ method: 'POST', url: REENTRY_URL, payload: validBody });

      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'rate_limit_unavailable' });
      expect(mockRequestLobbyReentryLink).not.toHaveBeenCalled();
    });

    it('there is no 404 and no 409 on this route — an unknown meeting still answers 202', async () => {
      vi.useFakeTimers();
      const pending = call({ method: 'POST', url: REENTRY_URL, payload: validBody });
      await vi.advanceTimersByTimeAsync(LOBBY_REENTRY_RESPONSE_FLOOR_MS);
      const res = await pending;

      expect(res.statusCode).not.toBe(404);
      expect(res.statusCode).not.toBe(409);
      expect(res.statusCode).toBe(202);
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

    // ── BAL-476 (R5 amended) — the exit-reason PROBE ────────────────────────────────

    it('⚠ forwards `probe: true` to the service', async () => {
      mockJoinAsGuest.mockResolvedValue({ ok: true, state: 'live' });

      const res = await call({
        method: 'POST',
        url: GUEST_JOIN_URL,
        payload: { ...validBody, probe: true },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ state: 'live' });
      expect(mockJoinAsGuest).toHaveBeenCalledWith(
        expect.objectContaining({ probe: true, rawGuestToken: RAW_TOKEN })
      );
    });

    it('⚠ a bare call forwards `probe: false`, so the ordinary join is unchanged', async () => {
      await call({ method: 'POST', url: GUEST_JOIN_URL, payload: validBody });

      expect(mockJoinAsGuest).toHaveBeenCalledWith(expect.objectContaining({ probe: false }));
    });

    /**
     * ⚠ `z.literal(true)`, NOT `z.boolean()` — `probe: false` is not a thing a caller should be
     * able to say, and a falsy value meaning "join for real" would be one typo from a mint.
     */
    it('⚠ answers 400 for `probe: false` and for a non-boolean probe', async () => {
      for (const probe of [false, 'true', 1]) {
        mockJoinAsGuest.mockClear();
        const res = await call({
          method: 'POST',
          url: GUEST_JOIN_URL,
          payload: { ...validBody, probe },
        });
        expect(res.statusCode).toBe(400);
        expect(mockJoinAsGuest).not.toHaveBeenCalled();
      }
    });

    /**
     * ⚠⚠ THE PROBE CONSUMES BOTH RATE-LIMIT WINDOWS, exactly like a poll. It sits AFTER them, so
     * it can only ever make this route do LESS work, never bypass a control.
     */
    it('⚠ a probe still consumes BOTH rate-limit windows', async () => {
      mockJoinAsGuest.mockResolvedValue({ ok: true, state: 'live' });

      await call({
        method: 'POST',
        url: GUEST_JOIN_URL,
        payload: { ...validBody, probe: true },
      });

      expect(mockCheckRateLimit).toHaveBeenCalledTimes(2);
      const prefixes = mockCheckRateLimit.mock.calls.map(
        (args) => (args[1] as { keyPrefix: string }).keyPrefix
      );
      expect(prefixes).toEqual([
        'ratelimit:meeting-guest-join:visitor',
        'ratelimit:meeting-guest-join:peer',
      ]);
    });

    it('⚠ a probe answers the SAME statuses a bare call does', async () => {
      for (const { code, status } of ERROR_STATUS) {
        mockJoinAsGuest.mockResolvedValue({ ok: false, code });
        const res = await call({
          method: 'POST',
          url: GUEST_JOIN_URL,
          payload: { ...validBody, probe: true },
        });
        expect(res.statusCode).toBe(status);
      }
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
