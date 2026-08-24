import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAuthorizeMeetingReschedule,
  mockRescheduleMeeting,
  mockIsWindowAvailableForExpert,
  mockCheckRateLimit,
  mockFindById,
  mockFindLiveByMeetingId,
  MeetingNotReschedulableErrorStub,
} = vi.hoisted(() => {
  class MeetingNotReschedulableErrorImpl extends Error {
    readonly meetingId: string;
    constructor(meetingId: string) {
      super(`Meeting ${meetingId} is not reschedulable (must be live and status='scheduled')`);
      this.name = 'MeetingNotReschedulableError';
      this.meetingId = meetingId;
    }
  }
  return {
    mockAuthorizeMeetingReschedule: vi.fn(),
    mockRescheduleMeeting: vi.fn(),
    mockIsWindowAvailableForExpert: vi.fn(),
    mockCheckRateLimit: vi.fn(),
    mockFindById: vi.fn(),
    mockFindLiveByMeetingId: vi.fn(),
    MeetingNotReschedulableErrorStub: MeetingNotReschedulableErrorImpl,
  };
});

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  MeetingNotReschedulableError: MeetingNotReschedulableErrorStub,
  meetingsRepository: { findById: mockFindById },
  meetingCalendarEventsRepository: { findLiveByMeetingId: mockFindLiveByMeetingId },
}));
// ⚠ SPREADS THE REAL MODULE — a bare factory would drop `RATE_LIMIT_DEADLINE_MS`, which
// `guards.js` imports, and a vitest factory mock throws on any export the graph touches but
// the factory omits.
vi.mock('../../lib/rate-limiter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/rate-limiter.js')>()),
  checkRateLimit: mockCheckRateLimit,
}));
vi.mock('../../lib/redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('../../lib/require-auth.js', () => ({
  requireAuth: async (request: { userId?: string; headers: Record<string, unknown> }) => {
    if (typeof request.headers.authorization !== 'string') return;
    request.userId = USER_ID;
  },
}));
vi.mock('../../services/meetings/authorize-meeting-reschedule.js', () => ({
  authorizeMeetingReschedule: mockAuthorizeMeetingReschedule,
}));
vi.mock('../../services/meetings/meeting-availability.js', () => ({
  rescheduleMeeting: mockRescheduleMeeting,
}));
vi.mock('../../services/availability/window-availability.js', () => ({
  isWindowAvailableForExpert: mockIsWindowAvailableForExpert,
}));
// ⚠ `./join.schema.js` and `./reschedule.schema.js` are DELIBERATELY NOT MOCKED — the real Zod
// boundary is what the `400` rows assert.

import Fastify, {
  type FastifyInstance,
  type InjectOptions,
  type LightMyRequestResponse,
} from 'fastify';
import { meetingRescheduleRoutes } from './reschedule.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const MEETING_ID = '22222222-2222-4222-8222-222222222222';
const EXPERT_PROFILE_ID = '66666666-6666-4666-8666-666666666666';
const URL = `/meetings/${MEETING_ID}/reschedule`;
const AUTH = { authorization: 'Bearer test-token' };

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * ⚠ NO FAKE TIMERS — `app.inject()` deadlocks under `vi.useFakeTimers()`. The route reads the
 * REAL clock, so windows are expressed relative to now, matching `index.test.ts`'s convention.
 */
function fromNow(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

const CURRENT_START = new Date(fromNow(DAY_MS));
const CURRENT_END = new Date(fromNow(DAY_MS + 30 * MINUTE_MS));
const NEW_START = fromNow(2 * DAY_MS);
// ⚠ B2 — derived from NEW_START + the CURRENT meeting's own duration, NEVER a second
// independent `fromNow()` call: the route now RECOMPUTES `scheduledEnd` server-side as
// `scheduledStart + (meeting.scheduledEnd - meeting.scheduledStart)`, so the expected fixture
// must do the identical arithmetic — two separate `Date.now()` reads can differ by 1ms and
// make an otherwise-correct assertion flake.
const CURRENT_DURATION_MS = CURRENT_END.getTime() - CURRENT_START.getTime();
const NEW_END = new Date(new Date(NEW_START).getTime() + CURRENT_DURATION_MS).toISOString();

function meetingRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: MEETING_ID,
    status: 'scheduled',
    scheduledStart: CURRENT_START,
    scheduledEnd: CURRENT_END,
    ...overrides,
  };
}

function authOk(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    meeting: meetingRow(),
    subject: { contextType: 'case', contextId: 'ctx-1' },
    companyId: 'company-1',
    expertProfileId: EXPERT_PROFILE_ID,
    ...overrides,
  };
}

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { scheduledStart: NEW_START, scheduledEnd: NEW_END, ...overrides };
}

describe('POST /meetings/:meetingId/reschedule (BAL-409)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    app.setErrorHandler((_error, _request, reply) => {
      reply.status(500).send({ error: 'Internal Server Error' });
    });
    await app.register(meetingRescheduleRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 19, ttlSeconds: 3600 });
    mockAuthorizeMeetingReschedule.mockResolvedValue(authOk());
    mockFindLiveByMeetingId.mockResolvedValue(undefined);
    mockIsWindowAvailableForExpert.mockResolvedValue(true);
    mockRescheduleMeeting.mockResolvedValue({
      meeting: {
        id: MEETING_ID,
        scheduledStart: new Date(NEW_START),
        scheduledEnd: new Date(NEW_END),
      },
      previous: { scheduledStart: CURRENT_START, scheduledEnd: CURRENT_END },
      expertProfileId: EXPERT_PROFILE_ID,
      guestLinksExtended: 0,
    });
    mockFindById.mockResolvedValue(meetingRow());
  });

  async function call(opts: InjectOptions): Promise<LightMyRequestResponse> {
    return app.inject(opts);
  }

  it('401 without a Bearer — the service is never reached', async () => {
    const res = await call({ method: 'POST', url: URL, payload: body() });

    expect(res.statusCode).toBe(401);
    expect(mockAuthorizeMeetingReschedule).not.toHaveBeenCalled();
  });

  it('400 on a malformed body (missing scheduledEnd)', async () => {
    const res = await call({
      method: 'POST',
      url: URL,
      headers: AUTH,
      payload: { scheduledStart: NEW_START },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_request' });
    expect(mockAuthorizeMeetingReschedule).not.toHaveBeenCalled();
  });

  // N9 — `.strict()` on `rescheduleMeetingBodySchema` was untested, and it is the ONLY thing
  // rejecting a smuggled extra field on the body (e.g. a client trying to pass its own
  // `meetingId` or some other value through the reschedule payload).
  it('400 invalid_request on a body with a smuggled extra field (rescheduleMeetingBodySchema.strict())', async () => {
    const res = await call({
      method: 'POST',
      url: URL,
      headers: AUTH,
      payload: { ...body(), extraField: 'not-allowed' },
    });

    expect(res.statusCode).toBe(400);
    // ⚠ `details` ARE echoed for the body — house style (Zod messages carry no server-side
    // uuid, `parseBodyOr400`'s contract) — so this asserts `error` only, via `toMatchObject`.
    expect(res.json()).toMatchObject({ error: 'invalid_request' });
    expect(mockAuthorizeMeetingReschedule).not.toHaveBeenCalled();
  });

  it('400 on a non-uuid meeting id', async () => {
    const res = await call({
      method: 'POST',
      url: '/meetings/not-a-uuid/reschedule',
      headers: AUTH,
      payload: body(),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_request' });
  });

  it('400 start_must_be_future when the proposed start has already passed', async () => {
    const res = await call({
      method: 'POST',
      url: URL,
      headers: AUTH,
      payload: body({
        scheduledStart: fromNow(-DAY_MS),
        scheduledEnd: fromNow(-DAY_MS + 30 * MINUTE_MS),
      }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'start_must_be_future' });
  });

  it('400 duration_below_minimum for a sub-15-minute window', async () => {
    const res = await call({
      method: 'POST',
      url: URL,
      headers: AUTH,
      payload: body({
        scheduledStart: NEW_START,
        scheduledEnd: fromNow(2 * DAY_MS + 5 * MINUTE_MS),
      }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'duration_below_minimum' });
  });

  // N9 — route tests covered only 2 of `WINDOW_VIOLATION_CODE`'s 6 branches. `invalid_instant`
  // is not reachable through this route (the Zod `.datetime()` boundary rejects malformed
  // timestamps before `validateBookingWindow` ever runs — the same posture `index.test.ts`
  // takes for `POST /meetings`), so it is not in this table either.
  it.each([
    {
      label: 'end before start',
      patch: { scheduledStart: fromNow(2 * DAY_MS), scheduledEnd: fromNow(DAY_MS) },
      error: 'invalid_window',
    },
    {
      label: 'a 481-minute window',
      patch: {
        scheduledStart: fromNow(2 * DAY_MS),
        scheduledEnd: fromNow(2 * DAY_MS + 481 * MINUTE_MS),
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
  ])(
    '400s "$error" on $label — BEFORE authorizeMeetingReschedule runs',
    async ({ patch, error }) => {
      const res = await call({ method: 'POST', url: URL, headers: AUTH, payload: body(patch) });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error });
      expect(mockAuthorizeMeetingReschedule).not.toHaveBeenCalled();
    }
  );

  it('404 meeting_not_found for a cross-tenant / unresolvable meeting', async () => {
    mockAuthorizeMeetingReschedule.mockResolvedValue({ ok: false, code: 'meeting_not_found' });

    const res = await call({ method: 'POST', url: URL, headers: AUTH, payload: body() });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'meeting_not_found' });
    expect(mockRescheduleMeeting).not.toHaveBeenCalled();
  });

  it.each(['waiting_for_participants', 'in_progress', 'ended', 'cancelled'])(
    '409 meeting_not_reschedulable for status=%s',
    async (status) => {
      mockAuthorizeMeetingReschedule.mockResolvedValue(authOk({ meeting: meetingRow({ status }) }));

      const res = await call({ method: 'POST', url: URL, headers: AUTH, payload: body() });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'meeting_not_reschedulable' });
    }
  );

  it('409 meeting_not_reschedulable when the current scheduled start has already passed', async () => {
    mockAuthorizeMeetingReschedule.mockResolvedValue(
      authOk({ meeting: meetingRow({ scheduledStart: new Date(fromNow(-MINUTE_MS)) }) })
    );

    const res = await call({ method: 'POST', url: URL, headers: AUTH, payload: body() });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'meeting_not_reschedulable' });
  });

  it('409 meeting_not_reschedulable on a TOCTOU race — the repo throws, and NO uuid reaches the wire', async () => {
    mockRescheduleMeeting.mockRejectedValue(new MeetingNotReschedulableErrorStub(MEETING_ID));

    const res = await call({ method: 'POST', url: URL, headers: AUTH, payload: body() });

    expect(res.statusCode).toBe(409);
    const responseText = res.body;
    expect(res.json()).toEqual({ error: 'meeting_not_reschedulable' });
    expect(responseText).not.toContain(MEETING_ID);
  });

  it('409 window_not_available when the expert-scoped guard refuses', async () => {
    mockIsWindowAvailableForExpert.mockResolvedValue(false);

    const res = await call({ method: 'POST', url: URL, headers: AUTH, payload: body() });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'window_not_available' });
    expect(mockRescheduleMeeting).not.toHaveBeenCalled();
  });

  it('threads excludeMeeting (self-collision fix) into isWindowAvailableForExpert', async () => {
    mockFindLiveByMeetingId.mockResolvedValue({ id: 'cal-event-1' });

    await call({ method: 'POST', url: URL, headers: AUTH, payload: body() });

    expect(mockIsWindowAvailableForExpert).toHaveBeenCalledWith(
      EXPERT_PROFILE_ID,
      new Date(NEW_START),
      new Date(NEW_END),
      expect.any(Date),
      expect.objectContaining({
        meetingId: MEETING_ID,
        currentStart: CURRENT_START,
        currentEnd: CURRENT_END,
        hasVendorEvent: true,
      })
    );
  });

  it('429 with Retry-After once the per-user window is spent, service never reached', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0, ttlSeconds: 900 });

    const res = await call({ method: 'POST', url: URL, headers: AUTH, payload: body() });

    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('900');
    expect(mockAuthorizeMeetingReschedule).not.toHaveBeenCalled();
  });

  it('503 rate_limit_unavailable — fails CLOSED, never "carry on unlimited"', async () => {
    mockCheckRateLimit.mockRejectedValue(new Error('redis unreachable'));

    const res = await call({ method: 'POST', url: URL, headers: AUTH, payload: body() });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'rate_limit_unavailable' });
    expect(mockAuthorizeMeetingReschedule).not.toHaveBeenCalled();
  });

  it('200 changed:false for the no-op guard — requested window equals the current one', async () => {
    const res = await call({
      method: 'POST',
      url: URL,
      headers: AUTH,
      payload: body({
        scheduledStart: CURRENT_START.toISOString(),
        scheduledEnd: CURRENT_END.toISOString(),
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ changed: false });
    expect(mockRescheduleMeeting).not.toHaveBeenCalled();
  });

  it('200 happy path, returning the COMMITTED window', async () => {
    const res = await call({ method: 'POST', url: URL, headers: AUTH, payload: body() });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      meetingId: MEETING_ID,
      scheduledStart: NEW_START,
      scheduledEnd: NEW_END,
      previousScheduledStart: CURRENT_START.toISOString(),
      previousScheduledEnd: CURRENT_END.toISOString(),
      changed: true,
    });
    expect(mockRescheduleMeeting).toHaveBeenCalledWith(
      MEETING_ID,
      { scheduledStart: new Date(NEW_START), scheduledEnd: new Date(NEW_END) },
      USER_ID,
      expect.anything()
    );
  });

  // B2 — a reschedule moves WHEN, never HOW LONG. The client's `scheduledEnd` must be
  // discarded and replaced with `scheduledStart + the meeting's CURRENT duration`, even when
  // the body asks for a wildly different (here: 8h) window.
  it('B2 — pins the duration: a body implying a different length does not resize the meeting', async () => {
    // Derived from NEW_START (not a second `fromNow()` read) so it lands well inside the
    // generic 15–480min shape check regardless of clock drift, while still implying a very
    // different (4h, not the current 30min) duration than the pinned meeting.
    const stretchedEnd = new Date(new Date(NEW_START).getTime() + 4 * 60 * MINUTE_MS).toISOString();

    const res = await call({
      method: 'POST',
      url: URL,
      headers: AUTH,
      payload: body({ scheduledStart: NEW_START, scheduledEnd: stretchedEnd }),
    });

    expect(res.statusCode).toBe(200);
    // The meeting's CURRENT duration (30min, from CURRENT_START/CURRENT_END) is preserved —
    // NOT the stretched 8h the body asked for.
    expect(mockRescheduleMeeting).toHaveBeenCalledWith(
      MEETING_ID,
      { scheduledStart: new Date(NEW_START), scheduledEnd: new Date(NEW_END) },
      USER_ID,
      expect.anything()
    );
    const [, calledSchedule] = mockRescheduleMeeting.mock.calls[0] as [
      string,
      { scheduledEnd: Date },
    ];
    expect(calledSchedule.scheduledEnd.toISOString()).not.toBe(stretchedEnd);
  });

  it('never echoes an internal message on an unexpected throw', async () => {
    mockRescheduleMeeting.mockRejectedValue(new Error('engagement 44444444 is not resolvable'));

    const res = await call({ method: 'POST', url: URL, headers: AUTH, payload: body() });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'Internal Server Error' });
  });
});
