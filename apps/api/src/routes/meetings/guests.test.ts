import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockInviteGuests,
  mockListGuests,
  mockRemoveGuest,
  mockDecideGuestAdmission,
  mockCheckRateLimit,
} = vi.hoisted(() => ({
  mockInviteGuests: vi.fn(),
  mockListGuests: vi.fn(),
  mockRemoveGuest: vi.fn(),
  mockDecideGuestAdmission: vi.fn(),
  mockCheckRateLimit: vi.fn(),
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
vi.mock('../../services/meetings/guest-participation.js', () => ({
  inviteGuests: mockInviteGuests,
  listGuests: mockListGuests,
  removeGuest: mockRemoveGuest,
  decideGuestAdmission: mockDecideGuestAdmission,
}));
// The invite window is Redis-backed (`POST /meetings`'s pattern). Mocked at the limiter, not
// at ioredis, so the assertions below read as "which window refused" rather than as Redis
// bookkeeping.
//
// ⚠ SPREADS THE REAL MODULE rather than replacing it wholesale. A `() => ({ checkRateLimit })`
// factory silently drops every OTHER export — and `RATE_LIMIT_DEADLINE_MS` arriving as
// `undefined` would make `setTimeout(fn, undefined)` fire on the next tick, timing out every
// request in this file for a reason that looks nothing like the cause.
vi.mock('../../lib/rate-limiter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/rate-limiter.js')>()),
  checkRateLimit: mockCheckRateLimit,
}));
// ⚠ `../../lib/with-deadline.js` IS DELIBERATELY NOT MOCKED — the real bound is what the
// outage test below exercises, and mocking it would assert nothing.
vi.mock('../../lib/redis.js', () => ({ getRedis: () => ({}) }));
// ⚠ `./guests.schema.js` and `../../lib/route-helpers.js` are DELIBERATELY NOT MOCKED — the
// real Zod boundary is exactly what the `400 invalid_request` rows below are asserting, and
// the fact that the schema has NO `party` / `accessScope` key is the security property.

import Fastify, {
  type FastifyInstance,
  type InjectOptions,
  type LightMyRequestResponse,
} from 'fastify';
// The REAL constant — the mock factory above spreads the original module, so this is the
// production deadline the route is actually wired with, not a test-local guess.
import { RATE_LIMIT_DEADLINE_MS } from '../../lib/rate-limiter.js';
import { meetingGuestRoutes } from './guests.js';

const USER_ID = '55555555-5555-4555-8555-555555555555';
const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const GUEST_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const AUTH_HEADERS = { authorization: 'Bearer test-token' };

const GUESTS_URL = `/meetings/${MEETING_ID}/guests`;
const GUEST_URL = `${GUESTS_URL}/${GUEST_ID}`;

/**
 * ⚠ THE STATUS TABLE, RESTATED HERE ON PURPOSE. `GUEST_ERROR_STATUS` is module-private, so
 * this is an INDEPENDENT statement of the mapping rather than a re-import of the thing under
 * test. A silent status change (a 409 quietly becoming a 400, say) breaks callers' retry and
 * error-copy logic without breaking a type.
 *
 * `delegate_must_be_client_side` is `422`, not `400`: the body was well-FORMED (Zod passed)
 * and the request is semantically impossible for THIS actor — which keeps the Zod literal
 * meaning only "malformed".
 */
const ERROR_STATUS: ReadonlyArray<{ code: string; status: number }> = [
  { code: 'meeting_not_found', status: 404 },
  { code: 'guest_not_found', status: 404 },
  { code: 'meeting_not_open_for_guests', status: 409 },
  { code: 'participant_cap_reached', status: 409 },
  { code: 'guest_already_invited', status: 409 },
  { code: 'guest_not_pending', status: 409 },
  { code: 'delegate_must_be_client_side', status: 422 },
];

/**
 * ⚠ DELETE CANNOT PRODUCE `meeting_not_open_for_guests`, AND THAT ABSENCE IS THE POINT.
 * `removeGuest` deliberately runs no meeting-state check: the join token keeps resolving for
 * `GUEST_TOKEN_TTL_AFTER_END_MS` (7 days) after a meeting `ended`, so gating revocation on
 * the terminal set would leave a live credential with no way to switch it off — and the
 * invite email promises the opposite in as many words. See `removeGuest`'s docblock.
 */
const DELETE_ERROR_STATUS = ERROR_STATUS.filter(
  (entry) => entry.code !== 'meeting_not_open_for_guests'
);

/** A well-formed invite body — individual tests override one field at a time. */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    entryPoint: 'case_surface',
    guests: [{ email: 'dana@northwind.example', name: 'Dana' }],
    ...overrides,
  };
}

/** The invite service's happy-path answer. */
function invited(): Record<string, unknown> {
  return {
    ok: true,
    guests: [
      {
        id: GUEST_ID,
        email: 'dana@northwind.example',
        name: 'Dana',
        party: 'client',
        participationRole: 'guest',
        accessScope: 'meeting',
        admission: 'pre_admitted',
        invitedAt: '2026-08-10T09:00:00.000Z',
      },
    ],
    participantCount: 3,
    participantCap: 10,
  };
}

describe('meeting guest routes (BAL-408)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    /**
     * ⚠ THE PRODUCTION ERROR HANDLER, RESTATED. `buildApp` installs exactly this
     * (`app.ts`), and without it a bare Fastify instance answers a thrown error with its
     * DEFAULT handler, which echoes `error.message` into the body. The routes below
     * deliberately re-throw after logging, so testing them against the default handler
     * would assert a leak that production does not have — and would hide a real one if the
     * app-level handler ever changed. Registering it here keeps the 500 rows honest.
     */
    app.setErrorHandler((_error, _request, reply) => {
      reply.status(500).send({ error: 'Internal Server Error' });
    });
    await app.register(meetingGuestRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({ allowed: true, current: 1, ttlSeconds: 3600 });
    mockInviteGuests.mockResolvedValue(invited());
    mockListGuests.mockResolvedValue({
      ok: true,
      guests: [{ id: GUEST_ID, name: 'Dana', displayName: 'Dana', party: 'client' }],
      canHost: false,
      participantCount: 3,
      participantCap: 10,
    });
    mockRemoveGuest.mockResolvedValue({ ok: true });
    mockDecideGuestAdmission.mockResolvedValue({
      ok: true,
      id: GUEST_ID,
      admission: 'admitted',
      decidedAt: '2026-09-01T10:05:00.000Z',
    });
  });

  /**
   * One typed entry point to `inject`.
   *
   * ⚠ NOT COSMETIC. `FastifyInstance.inject` is overloaded (`(opts) => Promise<Response>`
   * and `() => Chain`), and a call site whose options object is assembled dynamically — a
   * conditional spread, a `method` read out of an `it.each` row — resolves to the CHAIN
   * overload, whose result has no `statusCode`. Funnelling every call through one
   * `InjectOptions`-typed parameter keeps the promise overload selected.
   */
  async function call(opts: InjectOptions): Promise<LightMyRequestResponse> {
    return app.inject(opts);
  }

  /** POST an invite body to the route under test. */
  async function postInvite(
    payload: InjectOptions['payload'],
    url = GUESTS_URL
  ): Promise<LightMyRequestResponse> {
    return call({ method: 'POST', url, headers: AUTH_HEADERS, payload });
  }

  // ── The happy paths ───────────────────────────────────────────────────────

  describe('the five success shapes', () => {
    it('201s with the created rows and the roster counts AFTER the writes', async () => {
      const res = await postInvite(body());

      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({
        guests: invited().guests,
        participantCount: 3,
        participantCap: 10,
      });
    });

    it('threads the actor from the SESSION, never from the body', async () => {
      await postInvite(body({ actorUserId: 'someone-else', party: 'expert' }));

      expect(mockInviteGuests).toHaveBeenCalledWith({
        meetingId: MEETING_ID,
        actorUserId: USER_ID,
        entryPoint: 'case_surface',
        guests: [{ email: 'dana@northwind.example', name: 'Dana' }],
      });
    });

    it('⚠ STRIPS `party` and `accessScope` from the body before the service sees them', async () => {
      // Zod's default object behaviour drops unknown keys. That is the anti-cross-party
      // control: a caller cannot mint an expert-side participant or award itself the whole
      // retrospective engagement envelope.
      await postInvite(
        body({
          guests: [
            {
              email: 'dana@northwind.example',
              party: 'expert',
              accessScope: 'engagement',
              admission: 'admitted',
            },
          ],
        })
      );

      const [args] = mockInviteGuests.mock.calls[0] ?? [];
      expect(args).toEqual({
        meetingId: MEETING_ID,
        actorUserId: USER_ID,
        entryPoint: 'case_surface',
        guests: [{ email: 'dana@northwind.example' }],
      });
      expect(JSON.stringify(args)).not.toContain('accessScope');
      expect(JSON.stringify(args)).not.toContain('"party"');
    });

    it('200s the party-scoped roster with `canHost`', async () => {
      const res = await call({ method: 'GET', url: GUESTS_URL, headers: AUTH_HEADERS });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        guests: [{ id: GUEST_ID, name: 'Dana', displayName: 'Dana', party: 'client' }],
        canHost: false,
        participantCount: 3,
        participantCap: 10,
      });
      expect(mockListGuests).toHaveBeenCalledWith({
        meetingId: MEETING_ID,
        actorUserId: USER_ID,
      });
    });

    it('204s a removal, with an empty body', async () => {
      const res = await call({ method: 'DELETE', url: GUEST_URL, headers: AUTH_HEADERS });

      expect(res.statusCode).toBe(204);
      expect(res.body).toBe('');
      expect(mockRemoveGuest).toHaveBeenCalledWith({
        meetingId: MEETING_ID,
        guestId: GUEST_ID,
        actorUserId: USER_ID,
      });
    });

    it.each([
      { suffix: 'admit', decision: 'admitted' },
      { suffix: 'deny', decision: 'denied' },
    ])(
      '200s /$suffix and passes the "$decision" literal — the SERVER picks it',
      async ({ suffix, decision }) => {
        mockDecideGuestAdmission.mockResolvedValue({
          ok: true,
          id: GUEST_ID,
          admission: decision,
          decidedAt: '2026-09-01T10:05:00.000Z',
        });

        const res = await call({
          method: 'POST',
          url: `${GUEST_URL}/${suffix}`,
          headers: AUTH_HEADERS,
        });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
          id: GUEST_ID,
          admission: decision,
          decidedAt: '2026-09-01T10:05:00.000Z',
        });
        expect(mockDecideGuestAdmission).toHaveBeenCalledWith(
          expect.objectContaining({ decision, actorUserId: USER_ID })
        );
      }
    );
  });

  // ── The service literal → HTTP status table ───────────────────────────────

  describe('every service literal maps to a decided status, and to nothing else', () => {
    it.each(ERROR_STATUS)('POST /guests → $status on "$code"', async ({ code, status }) => {
      mockInviteGuests.mockResolvedValue({ ok: false, code });

      const res = await postInvite(body());

      expect(res.statusCode).toBe(status);
      expect(res.json()).toEqual({ error: code });
    });

    it.each(DELETE_ERROR_STATUS)(
      'DELETE /guests/:guestId → $status on "$code"',
      async ({ code, status }) => {
        mockRemoveGuest.mockResolvedValue({ ok: false, code });

        const res = await call({ method: 'DELETE', url: GUEST_URL, headers: AUTH_HEADERS });

        expect(res.statusCode).toBe(status);
        expect(res.json()).toEqual({ error: code });
      }
    );

    it.each(ERROR_STATUS)(
      'POST /guests/:guestId/admit → $status on "$code"',
      async ({ code, status }) => {
        mockDecideGuestAdmission.mockResolvedValue({ ok: false, code });

        const res = await call({
          method: 'POST',
          url: `${GUEST_URL}/admit`,
          headers: AUTH_HEADERS,
        });

        expect(res.statusCode).toBe(status);
        expect(res.json()).toEqual({ error: code });
      }
    );

    it('GET /guests → 404 on the gate’s literal', async () => {
      mockListGuests.mockResolvedValue({ ok: false, code: 'meeting_not_found' });

      const res = await call({ method: 'GET', url: GUESTS_URL, headers: AUTH_HEADERS });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'meeting_not_found' });
    });

    it('⚠ sends the fixed literal ALONE — never a `details` or `message` field', async () => {
      // Callers map these literals to copy. Echoing a service message would both leak server
      // detail and invite `err.message` rendering in a UI.
      mockInviteGuests.mockResolvedValue({ ok: false, code: 'participant_cap_reached' });

      const res = await postInvite(body());

      expect(Object.keys(res.json())).toEqual(['error']);
    });

    it('⚠ answers 403 on NOTHING — "not your party" and "not a host" are 404s', async () => {
      // `meeting_not_found` collapses "no such meeting", "not your party", "unresolvable
      // context" and "not a host"; `guest_not_found` collapses "no such guest" and "that
      // guest belongs to the other party".
      for (const code of ['meeting_not_found', 'guest_not_found']) {
        mockInviteGuests.mockResolvedValue({ ok: false, code });
        mockRemoveGuest.mockResolvedValue({ ok: false, code });
        mockDecideGuestAdmission.mockResolvedValue({ ok: false, code });

        const responses = await Promise.all([
          postInvite(body()),
          call({ method: 'DELETE', url: GUEST_URL, headers: AUTH_HEADERS }),
          call({ method: 'POST', url: `${GUEST_URL}/deny`, headers: AUTH_HEADERS }),
        ]);

        for (const res of responses) {
          expect(res.statusCode).toBe(404);
          expect(res.statusCode).not.toBe(403);
        }
      }
    });
  });

  // ── The invite window ─────────────────────────────────────────────────────

  /**
   * ⚠⚠ THIS ROUTE IS AN EMAIL-EMISSION PRIMITIVE — it sends mail from Balo's sending domain
   * to ANY address the actor names. The naive bounds do not hold it: the
   * `(meeting, party, email)` unique is PARTIAL and `revoke` vacates it, so
   * invite → remove → invite is an unbounded loop, and BullMQ jobId dedup never bites
   * because a fresh `meeting_guests.id` is minted each cycle. The Redis window is the bound.
   */
  describe('the invite rate limit is the bound on email amplification', () => {
    it('consumes BOTH windows — per (actor, meeting) first, then per actor', async () => {
      await postInvite(body());

      expect(mockCheckRateLimit).toHaveBeenCalledTimes(2);
      expect(mockCheckRateLimit).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        expect.objectContaining({ keyPrefix: 'ratelimit:meeting-guests:user-meeting' }),
        `${USER_ID}:${MEETING_ID}`
      );
      expect(mockCheckRateLimit).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        expect.objectContaining({ keyPrefix: 'ratelimit:meeting-guests:user' }),
        USER_ID
      );
    });

    it('429s with Retry-After and NEVER reaches the service, so no mail is emitted', async () => {
      mockCheckRateLimit.mockResolvedValue({ allowed: false, current: 7, ttlSeconds: 1800 });

      const res = await postInvite(body());

      expect(res.statusCode).toBe(429);
      expect(res.json()).toEqual({ error: 'rate_limited', cooldownSeconds: 1800 });
      expect(res.headers['retry-after']).toBe('1800');
      expect(mockInviteGuests).not.toHaveBeenCalled();
    });

    it('⚠ FAILS CLOSED on a Redis outage — 503, not an unmetered send window', async () => {
      mockCheckRateLimit.mockRejectedValue(new Error('Redis unavailable'));

      const res = await postInvite(body());

      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'rate_limit_unavailable' });
      expect(mockInviteGuests).not.toHaveBeenCalled();
    });

    /**
     * ⚠⚠ THE OUTAGE SHAPE THE TEST ABOVE CANNOT REACH — and the one that actually happens.
     *
     * The rejection case is the EASY one. The real Redis restart does not reject at all:
     * `getRedis()` sets `maxRetriesPerRequest: null` (BullMQ requires it), and ioredis only
     * flushes pending commands with an error when that option is a NUMBER — verified in
     * `ioredis@5.9.3/built/redis/event_handler.js`:
     *     if (typeof maxRetriesPerRequest === 'number') { … flushQueue(new MaxRetriesPerRequestError(…)) }
     * With `null` the branch is skipped, and `enableOfflineQueue` (default `true`) parks the
     * command instead. The promise NEVER SETTLES.
     *
     * Before the `withDeadline` bound that meant: the `catch` never ran, no 503 was ever
     * sent, and every in-flight invite hung holding a Fastify connection until an upstream
     * proxy timeout. The route's docblock claimed "answers 503, never carries on unlimited"
     * — true of the rejection path, false of this one.
     *
     * Fake timers, not a real 2s wait: the assertion is about the DEADLINE firing, and
     * advancing the clock proves that far more precisely than sleeping does.
     */
    it('⚠ 503s on a Redis that never answers at all, instead of hanging', async () => {
      vi.useFakeTimers();
      try {
        // Exactly what ioredis produces while disconnected: pending, forever.
        mockCheckRateLimit.mockReturnValue(new Promise(() => {}));

        const pending = postInvite(body());
        await vi.advanceTimersByTimeAsync(RATE_LIMIT_DEADLINE_MS + 1);
        const res = await pending;

        expect(res.statusCode).toBe(503);
        expect(res.json()).toEqual({ error: 'rate_limit_unavailable' });
        expect(mockInviteGuests).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('waits for the whole deadline — a merely slow Redis is not refused early', async () => {
      vi.useFakeTimers();
      try {
        mockCheckRateLimit.mockReturnValue(new Promise(() => {}));

        let settled = false;
        const pending = postInvite(body()).then((res) => {
          settled = true;
          return res;
        });

        await vi.advanceTimersByTimeAsync(RATE_LIMIT_DEADLINE_MS - 1);
        expect(settled).toBe(false);

        await vi.advanceTimersByTimeAsync(2);
        expect((await pending).statusCode).toBe(503);
      } finally {
        vi.useRealTimers();
      }
    });

    it('is ordered AFTER validation, so a malformed body cannot burn the window', async () => {
      const res = await postInvite(body({ guests: [] }));

      expect(res.statusCode).toBe(400);
      expect(mockCheckRateLimit).not.toHaveBeenCalled();
    });

    // DELETE does email the removed person, but it is bounded transitively: it can fire at
    // most once per guest ROW, and rows only come from POST. Limiting it separately would
    // buy nothing and could block a revocation — the one action that must always get through.
    it('does NOT limit the read, the removal or the admission decision', async () => {
      await call({ method: 'GET', url: GUESTS_URL, headers: AUTH_HEADERS });
      await call({ method: 'DELETE', url: GUEST_URL, headers: AUTH_HEADERS });
      await call({ method: 'POST', url: `${GUEST_URL}/admit`, headers: AUTH_HEADERS });

      expect(mockCheckRateLimit).not.toHaveBeenCalled();
    });
  });

  // ── 401 ───────────────────────────────────────────────────────────────────

  describe('401 without a bearer token, and the service is never reached', () => {
    it.each([
      { label: 'POST /guests', method: 'POST' as const, url: GUESTS_URL, payload: body() },
      { label: 'GET /guests', method: 'GET' as const, url: GUESTS_URL, payload: undefined },
      {
        label: 'DELETE /guests/:id',
        method: 'DELETE' as const,
        url: GUEST_URL,
        payload: undefined,
      },
      {
        label: 'POST /guests/:id/admit',
        method: 'POST' as const,
        url: `${GUEST_URL}/admit`,
        payload: undefined,
      },
      {
        label: 'POST /guests/:id/deny',
        method: 'POST' as const,
        url: `${GUEST_URL}/deny`,
        payload: undefined,
      },
    ])('$label', async ({ method, url, payload }) => {
      const res = await call({ method, url, ...(payload ? { payload } : {}) });

      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'Unauthorized' });
      expect(mockInviteGuests).not.toHaveBeenCalled();
      expect(mockListGuests).not.toHaveBeenCalled();
      expect(mockRemoveGuest).not.toHaveBeenCalled();
      expect(mockDecideGuestAdmission).not.toHaveBeenCalled();
    });
  });

  // ── 400 — the Zod boundary ────────────────────────────────────────────────

  describe('400 invalid_request on a malformed BODY, without touching the service', () => {
    it.each([
      { label: 'a missing entryPoint', patch: { entryPoint: undefined } },
      { label: 'an unknown entryPoint', patch: { entryPoint: 'email_footer' } },
      { label: 'an empty guests array', patch: { guests: [] } },
      { label: 'a missing guests array', patch: { guests: undefined } },
      {
        label: 'more than 8 guests (the parse-time size bound)',
        patch: {
          guests: Array.from({ length: 9 }, (_, i) => ({ email: `g${i}@northwind.example` })),
        },
      },
      { label: 'a malformed email', patch: { guests: [{ email: 'not-an-email' }] } },
      { label: 'a missing email', patch: { guests: [{ name: 'Dana' }] } },
      {
        label: 'an address longer than RFC 5321’s 254',
        patch: { guests: [{ email: `${'a'.repeat(250)}@northwind.example` }] },
      },
      {
        label: 'an unknown participationRole',
        patch: { guests: [{ email: 'dana@northwind.example', participationRole: 'observer' }] },
      },
      {
        label: 'an empty name',
        patch: { guests: [{ email: 'dana@northwind.example', name: '' }] },
      },
      {
        label: 'a name over 160 characters',
        patch: { guests: [{ email: 'dana@northwind.example', name: 'n'.repeat(161) }] },
      },
      { label: 'a `guests` value that is not an array', patch: { guests: 'dana@x.example' } },
      { label: 'an `entryPoint` that is not a string', patch: { entryPoint: 3 } },
    ])('400s on $label', async ({ patch }) => {
      const res = await postInvite(body(patch));

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_request');
      expect(mockInviteGuests).not.toHaveBeenCalled();
    });

    it('ACCEPTS the shipped entry points, which is what makes the rejections above meaningful', async () => {
      for (const entryPoint of ['booking_confirm', 'case_surface', 'in_call']) {
        vi.clearAllMocks();
        mockInviteGuests.mockResolvedValue(invited());

        const res = await postInvite(body({ entryPoint }));

        expect(res.statusCode).toBe(201);
        expect(mockInviteGuests).toHaveBeenCalledWith(expect.objectContaining({ entryPoint }));
      }
    });

    it('ACCEPTS a full batch of exactly 8 — the bound is inclusive', async () => {
      const res = await postInvite(
        body({
          guests: Array.from({ length: 8 }, (_, i) => ({ email: `g${i}@northwind.example` })),
        })
      );

      expect(res.statusCode).toBe(201);
    });
  });

  describe('400 invalid_request on a malformed PATH PARAM, without touching the service', () => {
    it.each([
      { label: 'POST /guests', method: 'POST' as const, url: '/meetings/not-a-uuid/guests' },
      { label: 'GET /guests', method: 'GET' as const, url: '/meetings/not-a-uuid/guests' },
      {
        label: 'DELETE with a bad meetingId',
        method: 'DELETE' as const,
        url: `/meetings/not-a-uuid/guests/${GUEST_ID}`,
      },
      {
        label: 'DELETE with a bad guestId',
        method: 'DELETE' as const,
        url: `${GUESTS_URL}/not-a-uuid`,
      },
      {
        label: 'admit with a bad guestId',
        method: 'POST' as const,
        url: `${GUESTS_URL}/not-a-uuid/admit`,
      },
      {
        label: 'deny with a bad meetingId',
        method: 'POST' as const,
        url: `/meetings/not-a-uuid/guests/${GUEST_ID}/deny`,
      },
    ])(
      '400s on $label — a malformed id never reaches Postgres as a 22P02',
      async ({ method, url }) => {
        const res = await call({
          method,
          url,
          headers: AUTH_HEADERS,
          ...(method === 'POST' && url.endsWith('/guests') ? { payload: body() } : {}),
        });

        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: 'invalid_request' });
        expect(mockInviteGuests).not.toHaveBeenCalled();
        expect(mockListGuests).not.toHaveBeenCalled();
        expect(mockRemoveGuest).not.toHaveBeenCalled();
        expect(mockDecideGuestAdmission).not.toHaveBeenCalled();
      }
    );

    it('⚠ validates the PARAMS before the BODY, so a bad id short-circuits with no `details`', async () => {
      const res = await postInvite({ nonsense: true }, '/meetings/not-a-uuid/guests');

      expect(res.statusCode).toBe(400);
      // The params branch sends the bare literal; only the Zod BODY branch adds `details`.
      expect(res.json()).toEqual({ error: 'invalid_request' });
    });
  });

  // ── 500 — an unexpected service throw ─────────────────────────────────────

  describe('an unexpected service throw becomes a 500 that leaks nothing', () => {
    it.each([
      {
        label: 'POST /guests',
        arrange: () => mockInviteGuests.mockRejectedValue(new Error('boom dana@secret.example')),
        request: () => postInvite(body()),
      },
      {
        label: 'DELETE /guests/:guestId',
        arrange: () => mockRemoveGuest.mockRejectedValue(new Error('boom dana@secret.example')),
        request: () => call({ method: 'DELETE', url: GUEST_URL, headers: AUTH_HEADERS }),
      },
      {
        label: 'POST /guests/:guestId/admit',
        arrange: () =>
          mockDecideGuestAdmission.mockRejectedValue(new Error('boom dana@secret.example')),
        request: () => call({ method: 'POST', url: `${GUEST_URL}/admit`, headers: AUTH_HEADERS }),
      },
    ])(
      '$label re-throws after logging, and the body carries no address',
      async ({ arrange, request }) => {
        arrange();

        const res = await request();

        expect(res.statusCode).toBe(500);
        expect(res.body).not.toContain('dana@secret.example');
      }
    );
  });

  // ── The credential never crosses the wire ─────────────────────────────────

  describe('⚠ no response body ever carries a token or a hash of one', () => {
    /** 43 base64url chars (the raw mint) or 64 hex chars (its digest). */
    const CREDENTIAL_PATTERN = /[A-Za-z0-9_-]{43}|\b[0-9a-f]{64}\b/;

    it('the invite response carries neither, and neither does the word `token`', async () => {
      const res = await postInvite(body());

      expect(res.body).not.toMatch(CREDENTIAL_PATTERN);
      expect(res.body.toLowerCase()).not.toContain('token');
      expect(res.body.toLowerCase()).not.toContain('tokenhash');
      expect(res.body).not.toContain('token_hash');
    });

    it.each([
      { label: 'the roster read', method: 'GET' as const, url: GUESTS_URL },
      { label: 'a removal', method: 'DELETE' as const, url: GUEST_URL },
      { label: 'an admit', method: 'POST' as const, url: `${GUEST_URL}/admit` },
      { label: 'a deny', method: 'POST' as const, url: `${GUEST_URL}/deny` },
    ])('nor does $label', async ({ method, url }) => {
      const res = await call({ method, url, headers: AUTH_HEADERS });

      expect(res.body).not.toMatch(CREDENTIAL_PATTERN);
      expect(res.body.toLowerCase()).not.toContain('token');
    });

    it('⚠ the invited-guest shape is EXACTLY the published contract — no extra key rides along', async () => {
      // These five routes are a PUBLISHED CONTRACT that BAL-400 / BAL-421 / BAL-132 consume
      // without modifying. Pinning the key set is what stops a later field (a token, an
      // internal id, a `tokenHash`) being echoed into three UIs by accident.
      const res = await postInvite(body());
      const [guest] = res.json().guests as Record<string, unknown>[];

      expect(Object.keys(guest ?? {}).sort((a, b) => a.localeCompare(b))).toEqual([
        'accessScope',
        'admission',
        'email',
        'id',
        'invitedAt',
        'name',
        'participationRole',
        'party',
      ]);
      expect(Object.keys(res.json()).sort((a, b) => a.localeCompare(b))).toEqual([
        'guests',
        'participantCap',
        'participantCount',
      ]);
    });

    it('⚠ the roster read never carries a cross-party address, because the service omitted it', async () => {
      // `projectGuestForViewer` omits rather than nulls; the route serialises whatever it got,
      // so an absent key must stay absent all the way to the wire.
      mockListGuests.mockResolvedValue({
        ok: true,
        guests: [{ id: GUEST_ID, name: 'Sam', displayName: 'Sam', party: 'expert' }],
        canHost: true,
        participantCount: 3,
        participantCap: 10,
      });

      const res = await call({ method: 'GET', url: GUESTS_URL, headers: AUTH_HEADERS });

      expect(res.body).not.toContain('email');
      expect(res.body).not.toContain('accessScope');
      expect(res.json().canHost).toBe(true);
    });
  });
});
