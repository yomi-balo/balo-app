import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAuthorizeMeetingBooking,
  mockBookAndProvisionMeeting,
  mockLookupBookingReplay,
  mockCheckRateLimit,
  mockIsWindowAvailableForExpert,
  MatchModeDiscoveryNotBookableError,
  MeetingContextNotProjectableError,
  MeetingContextRequiredError,
  MeetingContextUnresolvableError,
  MeetingExpertAmbiguousError,
  BookingIdempotencyKeyConflictError,
} = vi.hoisted(() => {
  /**
   * The real classes embed raw uuids in their messages, ON PURPOSE, so the SERVER log is
   * actionable. These stand-ins do the same — that is what makes the no-echo sweep at the
   * bottom of this file a real test rather than a tautology.
   */
  class MatchModeDiscoveryNotBookableError extends Error {
    constructor(id: string) {
      super(`Project request ${id} is in match mode (no expert assigned) and cannot be booked`);
      this.name = 'MatchModeDiscoveryNotBookableError';
    }
  }
  class MeetingExpertAmbiguousError extends Error {
    constructor(id: string) {
      super(`Meeting ${id} resolves to 2 experts (${id}, ${id}); a booking must name exactly one`);
      this.name = 'MeetingExpertAmbiguousError';
    }
  }
  class MeetingContextNotProjectableError extends Error {
    constructor(id: string) {
      super(`Meeting context type 'request_interaction' (${id}) has no projection rule yet`);
      this.name = 'MeetingContextNotProjectableError';
    }
  }
  class MeetingContextUnresolvableError extends Error {
    constructor(id: string) {
      super(`Meeting context case:${id} does not resolve to a live row`);
      this.name = 'MeetingContextUnresolvableError';
    }
  }
  class MeetingContextRequiredError extends Error {
    constructor() {
      super('A meeting requires at least one context (decision B / ADR-1045 §2)');
      this.name = 'MeetingContextRequiredError';
    }
  }
  // BAL-400 (Decision 7) — this one is REAL `provision-meeting.ts` shape, not `@balo/db`'s:
  // it also embeds a raw uuid (the existing meeting id) for the same no-echo reason.
  class BookingIdempotencyKeyConflictError extends Error {
    constructor(meetingId: string) {
      super(`Booking idempotency key already resolves to a different case (meeting ${meetingId})`);
      this.name = 'BookingIdempotencyKeyConflictError';
    }
  }
  return {
    mockAuthorizeMeetingBooking: vi.fn(),
    mockBookAndProvisionMeeting: vi.fn(),
    mockLookupBookingReplay: vi.fn(),
    mockCheckRateLimit: vi.fn(),
    mockIsWindowAvailableForExpert: vi.fn(),
    MatchModeDiscoveryNotBookableError,
    MeetingContextNotProjectableError,
    MeetingContextRequiredError,
    MeetingContextUnresolvableError,
    MeetingExpertAmbiguousError,
    BookingIdempotencyKeyConflictError,
  };
});

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  MatchModeDiscoveryNotBookableError,
  MeetingContextNotProjectableError,
  MeetingContextUnresolvableError,
  MeetingExpertAmbiguousError,
}));
vi.mock('../../lib/require-auth.js', () => ({
  requireAuth: async (request: { userId?: string; headers: Record<string, unknown> }) => {
    // Mirrors the real preHandler closely enough to exercise the 401 branch.
    if (typeof request.headers.authorization !== 'string') return;
    request.userId = USER_ID;
  },
}));
vi.mock('../../services/meetings/authorize-meeting-booking.js', () => ({
  authorizeMeetingBooking: mockAuthorizeMeetingBooking,
}));
vi.mock('../../services/meetings/provision-meeting.js', () => ({
  bookAndProvisionMeeting: mockBookAndProvisionMeeting,
  lookupBookingReplay: mockLookupBookingReplay,
  BookingIdempotencyKeyConflictError,
}));
// The rate limiter is faked at the `checkRateLimit` seam, not at Redis: the assertions are
// about WHICH keys the route consumes and how it behaves on `allowed: false` / a throw, none
// of which needs a real Redis. `getRedis` is stubbed only so it cannot demand `REDIS_URL`.
//
// ⚠ SPREADS THE REAL MODULE rather than replacing it wholesale — a bare factory would drop
// `RATE_LIMIT_DEADLINE_MS`, and an `undefined` deadline makes `setTimeout` fire on the next
// tick, timing out every booking in this file for a reason that looks nothing like the cause.
vi.mock('../../lib/rate-limiter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/rate-limiter.js')>()),
  checkRateLimit: mockCheckRateLimit,
}));
vi.mock('../../lib/redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('../../services/availability/window-availability.js', () => ({
  isWindowAvailableForExpert: mockIsWindowAvailableForExpert,
}));
// `@balo/shared/meetings` is NOT mocked — the real `validateBookingWindow` is what the
// window rows of the error table are actually asserting.

import Fastify, { type FastifyInstance } from 'fastify';
import { meetingsRoutes } from './index.js';

const USER_ID = '55555555-5555-4555-8555-555555555555';
const CONTEXT_ID = '33333333-3333-4333-8333-333333333333';
const EXPERT_PROFILE_ID = '66666666-6666-4666-8666-666666666666';
const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const ROOM_NAME = 'balo-0f7b1c2d3e4f4a5b8c9d0e1f2a3b4c5d';
const JOIN_URL = `https://balo.daily.co/${ROOM_NAME}`;

const AUTH_HEADERS = { authorization: 'Bearer test-token' };

/**
 * ⚠ NO FAKE TIMERS IN THIS FILE. `vi.useFakeTimers()` deadlocks `app.inject()` —
 * light-my-request drives the request through the event loop, so faking timers makes every
 * injection hang until the 5s test timeout. The route reads the REAL clock via
 * `validateBookingWindow(start, end, new Date())`, so every timestamp below is expressed
 * RELATIVE TO NOW instead. `bounds.test.ts` covers the boundary arithmetic exactly, with an
 * injected `now`; this file only needs windows that are unambiguously on one side of each
 * rule, which relative offsets give.
 */
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** An ISO instant `ms` from now. */
function fromNow(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

/** The default well-formed window: one hour, starting a day out. */
const START = fromNow(DAY_MS);
const END = fromNow(DAY_MS + 60 * MINUTE_MS);

/** A well-formed body — individual tests override one field at a time. */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contextType: 'case',
    contextId: CONTEXT_ID,
    scheduledStart: START,
    scheduledEnd: END,
    ...overrides,
  };
}

/** A meeting row as the service returns it. */
function bookedMeeting(): Record<string, unknown> {
  return {
    id: MEETING_ID,
    scheduledStart: new Date(START),
    scheduledEnd: new Date(END),
  };
}

describe('POST /meetings', () => {
  let app: FastifyInstance;

  /**
   * POST to the route under test. Factored out because the same six-line `inject` block
   * otherwise appears in every one of ~20 cases — exactly the shape SonarCloud's duplication
   * gate flags, and one more place to get the url or the auth header subtly wrong.
   */
  async function post(payload: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: '/meetings', headers: AUTH_HEADERS, payload });
  }

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(meetingsRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({ allowed: true, current: 1, ttlSeconds: 3600 });
    mockIsWindowAvailableForExpert.mockResolvedValue(true);
    // Default: this key names nothing yet, so every guard runs exactly as before.
    mockLookupBookingReplay.mockResolvedValue({ kind: 'none' });
    mockAuthorizeMeetingBooking.mockResolvedValue({
      ok: true,
      companyId: 'company_1',
      engagementType: 'case',
      expertProfileId: EXPERT_PROFILE_ID,
    });
    mockBookAndProvisionMeeting.mockResolvedValue({
      meeting: bookedMeeting(),
      provisioned: true,
      dailyRoomName: ROOM_NAME,
      joinUrl: JOIN_URL,
    });
  });

  // ── The success rows ──────────────────────────────────────────────────────

  it('201s with the provisioned venue on the happy path', async () => {
    const res = await post(body());

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      meetingId: MEETING_ID,
      scheduledStart: START,
      scheduledEnd: END,
      provisioned: true,
      dailyRoomName: ROOM_NAME,
      joinUrl: JOIN_URL,
    });
    // The response deliberately carries NO expertProfileId and NO context echo.
    expect(res.json()).not.toHaveProperty('expertProfileId');
  });

  it('201s with provisioned:false and null venue when the vendor failed (§3.2)', async () => {
    // A booking that committed with no room is a SUCCESS WITH A MISSING ARTEFACT. A 502 here
    // would tell the client "this failed" about a booking that exists and blocks an expert.
    mockBookAndProvisionMeeting.mockResolvedValue({
      meeting: bookedMeeting(),
      provisioned: false,
      dailyRoomName: null,
      joinUrl: null,
    });

    const res = await post(body());

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      meetingId: MEETING_ID,
      provisioned: false,
      dailyRoomName: null,
      joinUrl: null,
    });
  });

  it('threads the gate’s resolved engagementType into the service, not the client’s claim', async () => {
    mockAuthorizeMeetingBooking.mockResolvedValue({
      ok: true,
      companyId: 'company_1',
      engagementType: 'project',
      expertProfileId: EXPERT_PROFILE_ID,
    });

    await post(body({ contextType: 'project_kickoff' }));

    expect(mockBookAndProvisionMeeting).toHaveBeenCalledWith(
      expect.objectContaining({
        contextType: 'project_kickoff',
        contextId: CONTEXT_ID,
        engagementType: 'project',
        userId: USER_ID,
      }),
      expect.anything()
    );
  });

  // ── BAL-400 (Decision 7) — bookingIdempotencyKey ────────────────────────────

  describe('bookingIdempotencyKey', () => {
    const KEY = 'a'.repeat(64);

    it('is OPTIONAL — the three other context types keep working with no key at all', async () => {
      const res = await post(body());

      expect(res.statusCode).toBe(201);
      expect(mockBookAndProvisionMeeting).toHaveBeenCalledWith(
        expect.objectContaining({ bookingIdempotencyKey: undefined }),
        expect.anything()
      );
    });

    it('threads a well-formed key into bookAndProvisionMeeting', async () => {
      const res = await post(body({ bookingIdempotencyKey: KEY }));

      expect(res.statusCode).toBe(201);
      expect(mockBookAndProvisionMeeting).toHaveBeenCalledWith(
        expect.objectContaining({ bookingIdempotencyKey: KEY }),
        expect.anything()
      );
    });

    it.each([
      { label: 'too short', key: 'a'.repeat(63) },
      { label: 'too long', key: 'a'.repeat(65) },
      { label: 'uppercase hex', key: 'A'.repeat(64) },
      { label: 'non-hex characters', key: 'z'.repeat(64) },
    ])('400s invalid_request on a malformed key ($label)', async ({ key }) => {
      const res = await post(body({ bookingIdempotencyKey: key }));

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid_request' });
      expect(mockBookAndProvisionMeeting).not.toHaveBeenCalled();
    });

    it('a repeated POST with the same key returns 201 with the SAME meetingId (the service owns the replay)', async () => {
      // The route's job is only to thread the key through and map the service's typed
      // errors — the actual dedup/replay logic is `bookAndProvisionMeeting`'s
      // (service-level tests in `provision-meeting.test.ts`). Here we just pin that TWO
      // identical POSTs against a mocked service both 201 with the SAME meetingId and that
      // the route creates no second anything of its own.
      mockBookAndProvisionMeeting.mockResolvedValue({
        meeting: bookedMeeting(),
        provisioned: true,
        dailyRoomName: ROOM_NAME,
        joinUrl: JOIN_URL,
      });

      const first = await post(body({ bookingIdempotencyKey: KEY }));
      const second = await post(body({ bookingIdempotencyKey: KEY }));

      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      expect(first.json().meetingId).toBe(MEETING_ID);
      expect(second.json().meetingId).toBe(MEETING_ID);
    });

    // ── S3/M1 regression: THE GUARD ORDER ───────────────────────────────────
    //
    // ⚠⚠ THESE TESTS DRIVE `isWindowAvailableForExpert` TO **FALSE**, ON PURPOSE. The
    // pre-existing case above mocks it `true`, which is exactly why S3 was invisible to CI:
    // in production a committed booking writes its own `confirmed` consultation row, and the
    // very next availability read sees that row and answers BUSY. So `false` — not `true` —
    // is what the lost-201 retry actually meets, and a replay that only works when the window
    // reads free is a replay that never runs.

    it('REPLAYS with 201 even when the window now reads BUSY (the lost-201 retry, S3)', async () => {
      mockLookupBookingReplay.mockResolvedValue({ kind: 'match', meeting: bookedMeeting() });
      mockIsWindowAvailableForExpert.mockResolvedValue(false);

      const res = await post(body({ bookingIdempotencyKey: KEY }));

      expect(res.statusCode).toBe(201);
      expect(res.json().meetingId).toBe(MEETING_ID);
      // The availability gate must not even have been consulted, and the per-pair limit must
      // not have been consumed a second time.
      expect(mockIsWindowAvailableForExpert).not.toHaveBeenCalled();
      expect(mockCheckRateLimit).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ keyPrefix: 'ratelimit:meetings:user-expert' }),
        expect.anything()
      );
      expect(mockBookAndProvisionMeeting).toHaveBeenCalledTimes(1);
    });

    it('still 409s window_not_available when the key names NOTHING (no replay to lean on)', async () => {
      mockLookupBookingReplay.mockResolvedValue({ kind: 'none' });
      mockIsWindowAvailableForExpert.mockResolvedValue(false);

      const res = await post(body({ bookingIdempotencyKey: KEY }));

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'window_not_available' });
      expect(mockBookAndProvisionMeeting).not.toHaveBeenCalled();
    });

    it('a key naming a DIFFERENT booking keeps every guard — no skip on a conflict', async () => {
      mockLookupBookingReplay.mockResolvedValue({ kind: 'conflict', meetingId: MEETING_ID });
      mockIsWindowAvailableForExpert.mockResolvedValue(false);

      const res = await post(body({ bookingIdempotencyKey: KEY }));

      expect(res.statusCode).toBe(409);
      expect(mockIsWindowAvailableForExpert).toHaveBeenCalled();
    });

    it('NEVER skips the tenancy gate for a replay — the key proves only who minted it', async () => {
      mockLookupBookingReplay.mockResolvedValue({ kind: 'match', meeting: bookedMeeting() });
      mockAuthorizeMeetingBooking.mockResolvedValue({ ok: false, code: 'context_not_found' });

      const res = await post(body({ bookingIdempotencyKey: KEY }));

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: 'context_not_found' });
      expect(mockBookAndProvisionMeeting).not.toHaveBeenCalled();
      // The probe must not even run before the gate has answered.
      expect(mockLookupBookingReplay).not.toHaveBeenCalled();
    });

    it('never probes at all when no key is supplied', async () => {
      await post(body());
      expect(mockLookupBookingReplay).not.toHaveBeenCalled();
    });
  });

  // ── 401 ───────────────────────────────────────────────────────────────────

  it('401s with no bearer token, and never reaches the gate', async () => {
    const res = await app.inject({ method: 'POST', url: '/meetings', payload: body() });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Unauthorized' });
    expect(mockAuthorizeMeetingBooking).not.toHaveBeenCalled();
  });

  // ── 400 — Zod ─────────────────────────────────────────────────────────────

  it.each([
    { label: 'an unknown context type', patch: { contextType: 'retainer_checkin' } },
    { label: 'the excluded `admin` label', patch: { contextType: 'admin' } },
    {
      label: 'the D3-excluded `request_interaction` label',
      patch: { contextType: 'request_interaction' },
    },
    { label: 'a non-uuid contextId', patch: { contextId: 'not-a-uuid' } },
    { label: 'a malformed start timestamp', patch: { scheduledStart: '2026-13-45' } },
    { label: 'a missing end timestamp', patch: { scheduledEnd: undefined } },
  ])('400s invalid_request on $label, without touching the gate', async ({ patch }) => {
    const res = await post(body(patch));

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_request');
    expect(mockAuthorizeMeetingBooking).not.toHaveBeenCalled();
  });

  // ── 400 — the booking window (D10) ────────────────────────────────────────

  it.each([
    {
      label: 'end before start',
      patch: { scheduledStart: fromNow(2 * DAY_MS), scheduledEnd: fromNow(DAY_MS) },
      error: 'invalid_window',
    },
    {
      label: 'a start in the past',
      patch: { scheduledStart: fromNow(-2 * DAY_MS), scheduledEnd: fromNow(-DAY_MS) },
      error: 'start_must_be_future',
    },
    {
      label: 'a 14-minute window',
      patch: {
        scheduledStart: fromNow(DAY_MS),
        scheduledEnd: fromNow(DAY_MS + 14 * MINUTE_MS),
      },
      error: 'duration_below_minimum',
    },
    {
      label: 'a 481-minute window',
      patch: {
        scheduledStart: fromNow(DAY_MS),
        scheduledEnd: fromNow(DAY_MS + 481 * MINUTE_MS),
      },
      error: 'duration_above_maximum',
    },
    {
      label: 'a start 366 days out',
      patch: {
        scheduledStart: fromNow(366 * DAY_MS),
        scheduledEnd: fromNow(366 * DAY_MS + 60 * MINUTE_MS),
      },
      error: 'beyond_booking_horizon',
    },
  ])('400s "$error" on $label — BEFORE any database round-trip', async ({ patch, error }) => {
    const res = await post(body(patch));

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error });
    // A malformed window must not cost a DB read, and a 400 that leaks nothing beats a 404
    // that confirms a uuid.
    expect(mockAuthorizeMeetingBooking).not.toHaveBeenCalled();
  });

  // ── The gate's TWO outcomes ───────────────────────────────────────────────

  it.each([
    { code: 'context_not_found', status: 404 },
    { code: 'context_type_mismatch', status: 400 },
  ])(
    '$status on the gate’s "$code" rejection, without booking anything',
    async ({ code, status }) => {
      mockAuthorizeMeetingBooking.mockResolvedValue({ ok: false, code });

      const res = await post(body());

      expect(res.statusCode).toBe(status);
      expect(res.json()).toEqual({ error: code });
      expect(mockBookAndProvisionMeeting).not.toHaveBeenCalled();
    }
  );

  it('NEVER answers 403 — a non-member and a nonexistent context are one 404 literal', async () => {
    // The gate has no `forbidden` code at all: distinguishing "this uuid is a live engagement
    // belonging to a company you are not in" from "no such row" is precisely the cross-tenant
    // existence oracle `authorize-meeting-booking.ts` collapses. Matches
    // `sessionActorErrorStatus`'s `not_found → 404` "(also hides existence)".
    mockAuthorizeMeetingBooking.mockResolvedValue({ ok: false, code: 'context_not_found' });

    const res = await post(body());

    expect(res.statusCode).toBe(404);
    expect(res.statusCode).not.toBe(403);
    expect(res.json()).toEqual({ error: 'context_not_found' });
  });

  // ── The aggregate availability bounds (§2) ────────────────────────────────

  describe('rate limiting — per-user AND per-(user, expert), failing CLOSED', () => {
    /**
     * ⚠ WHY BOTH KEYS. Availability validation stops a caller taking a slot the expert never
     * published, but nothing in it stops one actor WALKING a published calendar. The per-pair
     * key is what bounds that; the per-user key bounds total attempts across all experts.
     */
    it('consumes the per-USER window before it parses the body or reads the database', async () => {
      await post(body());

      expect(mockCheckRateLimit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ keyPrefix: 'ratelimit:meetings:user' }),
        USER_ID
      );
    });

    it('consumes a per-(USER, EXPERT) window keyed on the expert the GATE resolved', async () => {
      await post(body());

      expect(mockCheckRateLimit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ keyPrefix: 'ratelimit:meetings:user-expert' }),
        `${USER_ID}:${EXPERT_PROFILE_ID}`
      );
    });

    it('429s on the per-user window, WITHOUT touching the gate', async () => {
      mockCheckRateLimit.mockResolvedValue({ allowed: false, current: 31, ttlSeconds: 1800 });

      const res = await post(body());

      expect(res.statusCode).toBe(429);
      expect(res.json()).toEqual({ error: 'rate_limited', cooldownSeconds: 1800 });
      expect(res.headers['retry-after']).toBe('1800');
      expect(mockAuthorizeMeetingBooking).not.toHaveBeenCalled();
    });

    it('429s on the per-pair window AFTER the gate, without booking or checking availability', async () => {
      mockCheckRateLimit
        .mockResolvedValueOnce({ allowed: true, current: 1, ttlSeconds: 3600 })
        .mockResolvedValueOnce({ allowed: false, current: 11, ttlSeconds: 900 });

      const res = await post(body());

      expect(res.statusCode).toBe(429);
      expect(res.json()).toEqual({ error: 'rate_limited', cooldownSeconds: 900 });
      expect(mockAuthorizeMeetingBooking).toHaveBeenCalled();
      expect(mockIsWindowAvailableForExpert).not.toHaveBeenCalled();
      expect(mockBookAndProvisionMeeting).not.toHaveBeenCalled();
    });

    it('503s and books NOTHING when Redis throws — FAIL-CLOSED, unlike /experts/search', async () => {
      // The search limiter fails OPEN on purpose (public, read-only). This route WRITES and
      // blocks a marketplace expert's calendar, so an outage must not become an unmetered
      // booking window.
      mockCheckRateLimit.mockRejectedValue(new Error('Redis unavailable'));

      const res = await post(body());

      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'rate_limit_unavailable' });
      expect(mockAuthorizeMeetingBooking).not.toHaveBeenCalled();
      expect(mockBookAndProvisionMeeting).not.toHaveBeenCalled();
    });

    it('503s fail-closed on the per-PAIR window too', async () => {
      mockCheckRateLimit
        .mockResolvedValueOnce({ allowed: true, current: 1, ttlSeconds: 3600 })
        .mockRejectedValueOnce(new Error('Redis unavailable'));

      const res = await post(body());

      expect(res.statusCode).toBe(503);
      expect(mockBookAndProvisionMeeting).not.toHaveBeenCalled();
    });
  });

  describe('real-availability validation — the load-bearing aggregate bound', () => {
    it('checks the proposed window against the resolved expert before booking', async () => {
      await post(body());

      // BAL-409 — `enforceExpertScopedGuards` (guards.ts, now shared with the reschedule
      // route) threads a 5th `excludeMeeting` parameter through unconditionally; the booking
      // route never supplies one, so it always arrives as `undefined` here. Byte-identical
      // runtime behaviour to before — `isWindowAvailableForExpert`'s 5th parameter is optional
      // and `undefined` is its "omitted" value — but the call now carries 5 arguments, not 4.
      expect(mockIsWindowAvailableForExpert).toHaveBeenCalledWith(
        EXPERT_PROFILE_ID,
        new Date(START),
        new Date(END),
        expect.any(Date),
        undefined
      );
    });

    it('409s window_not_available and books NOTHING when the window is not free', async () => {
      // ⚠ ONE FIXED LITERAL, NO REASON. Enumerating WHY (outside published hours / already
      // booked / inside a time-off block / below minimum notice) would turn this route into a
      // free-busy oracle over the expert's private calendar for anyone holding a context id.
      mockIsWindowAvailableForExpert.mockResolvedValue(false);

      const res = await post(body());

      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'window_not_available' });
      expect(mockBookAndProvisionMeeting).not.toHaveBeenCalled();
    });

    it('SKIPS both expert-scoped guards when the gate resolved no expert (match mode)', async () => {
      // A `match`-routed `project_discovery` names nobody, so there is no calendar to check and
      // no pair to limit. The repository then throws `MatchModeDiscoveryNotBookableError` →
      // `409 discovery_not_routed`. A skip, not a bypass.
      mockAuthorizeMeetingBooking.mockResolvedValue({
        ok: true,
        companyId: 'company_1',
        engagementType: null,
        expertProfileId: null,
      });
      mockBookAndProvisionMeeting.mockRejectedValue(
        new MatchModeDiscoveryNotBookableError(CONTEXT_ID)
      );

      const res = await post(body({ contextType: 'project_discovery' }));

      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'discovery_not_routed' });
      expect(mockIsWindowAvailableForExpert).not.toHaveBeenCalled();
      // Only the per-USER window was consumed — there is no pair to key on.
      expect(mockCheckRateLimit).toHaveBeenCalledTimes(1);
    });
  });

  // ── The typed repository errors ───────────────────────────────────────────

  it('404s context_not_found on MeetingContextUnresolvableError (the TOCTOU race)', async () => {
    // Reuses the gate's literal on purpose: after the gate resolved the row, this means the
    // subject was soft-deleted between the read and the write. Same fact, same literal.
    mockBookAndProvisionMeeting.mockRejectedValue(new MeetingContextUnresolvableError(CONTEXT_ID));

    const res = await post(body());

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'context_not_found' });
  });

  it.each([
    { Err: MatchModeDiscoveryNotBookableError, error: 'discovery_not_routed' },
    { Err: MeetingExpertAmbiguousError, error: 'meeting_expert_ambiguous' },
    { Err: MeetingContextNotProjectableError, error: 'context_not_bookable' },
    // BAL-400 (Decision 7) — a `bookingIdempotencyKey` that already resolves to a meeting
    // booked against a DIFFERENT context.
    { Err: BookingIdempotencyKeyConflictError, error: 'idempotency_key_conflict' },
  ])('409s "$error" on the matching typed error', async ({ Err, error }) => {
    mockBookAndProvisionMeeting.mockRejectedValue(new Err(CONTEXT_ID));

    const res = await post(body());

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error });
  });

  it('500s on MeetingContextRequiredError — DELIBERATELY unmapped, structurally unreachable', async () => {
    // The route always passes exactly one context. Mapping it would be dead code SonarCloud
    // counts as uncovered; if it ever fires, the route's own construction broke and a
    // Sentry-captured 500 is the correct signal.
    mockBookAndProvisionMeeting.mockRejectedValue(new MeetingContextRequiredError());

    const res = await post(body());

    expect(res.statusCode).toBe(500);
  });

  // ── The no-echo rule, made mechanical ─────────────────────────────────────

  describe('no response body leaks a uuid from a typed error message', () => {
    /**
     * ⚠ THE `err.message` NO-ECHO RULE AS A SWEEP. The typed errors embed raw uuids
     * (engagement ids, project-request ids, expert-profile ids) so the SERVER log is
     * actionable; `meeting-availability.ts` forbids passing them to the client. Any future
     * "helpful" `details: error.message` fails here.
     */
    const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

    it.each([
      { label: 'MeetingContextUnresolvableError', Err: MeetingContextUnresolvableError },
      { label: 'MatchModeDiscoveryNotBookableError', Err: MatchModeDiscoveryNotBookableError },
      { label: 'MeetingExpertAmbiguousError', Err: MeetingExpertAmbiguousError },
      { label: 'MeetingContextNotProjectableError', Err: MeetingContextNotProjectableError },
      { label: 'BookingIdempotencyKeyConflictError', Err: BookingIdempotencyKeyConflictError },
    ])('$label', async ({ Err }) => {
      const thrown = new Err(CONTEXT_ID);
      // Sanity: the message really does carry a uuid, so the assertion below has teeth.
      expect(thrown.message).toMatch(UUID_PATTERN);
      mockBookAndProvisionMeeting.mockRejectedValue(thrown);

      const res = await post(body());

      expect(res.body).not.toMatch(UUID_PATTERN);
    });

    it('and neither does a gate rejection or a window rejection', async () => {
      mockAuthorizeMeetingBooking.mockResolvedValue({ ok: false, code: 'context_not_found' });
      const gateRes = await post(body());
      expect(gateRes.body).not.toMatch(UUID_PATTERN);

      const windowRes = await post(body({ scheduledStart: END, scheduledEnd: START }));
      expect(windowRes.body).not.toMatch(UUID_PATTERN);
    });

    it('and neither does an availability refusal or a rate-limit refusal', async () => {
      // The per-pair rate-limit KEY embeds both uuids and the availability call takes the
      // expert profile id — neither may surface in a body.
      mockIsWindowAvailableForExpert.mockResolvedValue(false);
      const availabilityRes = await post(body());
      expect(availabilityRes.body).not.toMatch(UUID_PATTERN);

      mockCheckRateLimit.mockResolvedValue({ allowed: false, current: 99, ttlSeconds: 60 });
      const limitedRes = await post(body());
      expect(limitedRes.body).not.toMatch(UUID_PATTERN);
    });
  });
});
