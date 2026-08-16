import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetMeetingState, mockCheckRateLimit, mockResolveTimers, mockWarn } = vi.hoisted(() => ({
  mockGetMeetingState: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockResolveTimers: vi.fn(),
  mockWarn: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mockWarn, error: vi.fn() }),
}));
vi.mock('../../lib/require-auth.js', () => ({
  requireAuth: async (request: { userId?: string; headers: Record<string, unknown> }) => {
    if (typeof request.headers.authorization !== 'string') return;
    request.userId = USER_ID;
  },
}));
vi.mock('../../services/meetings/meeting-state.js', () => ({
  getMeetingState: mockGetMeetingState,
}));
vi.mock('../../config/meeting-timers.js', () => ({ resolveMeetingTimers: mockResolveTimers }));
// ⚠ SPREADS THE REAL MODULE. A `() => ({ checkRateLimit })` factory silently drops
// `RATE_LIMIT_DEADLINE_MS`, and `setTimeout(fn, undefined)` fires on the next tick — timing out
// every request in this file for a reason that looks nothing like the cause.
vi.mock('../../lib/rate-limiter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/rate-limiter.js')>()),
  checkRateLimit: mockCheckRateLimit,
}));
vi.mock('../../lib/redis.js', () => ({ getRedis: () => ({}) }));

import Fastify, {
  type FastifyInstance,
  type InjectOptions,
  type LightMyRequestResponse,
} from 'fastify';
import { meetingStateRoutes } from './state.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const MEETING_ID = '22222222-2222-4222-8222-222222222222';
const URL = `/meetings/${MEETING_ID}/state`;
const AUTH = { authorization: 'Bearer test-token' };

const TIMERS = {
  expertAbsentAlertMs: 300_000,
  missedCallTerminationMs: 600_000,
  clientAbsentNudgeMs: 300_000,
  noShowFloorMs: 900_000,
  idleEndEmptyMs: 300_000,
};

const STATE = {
  status: 'waiting_for_participants',
  outcome: null,
  endedBy: null,
  viewerRole: 'expert',
  phase: 'near',
  clocks: {
    expertPresentMs: 300_000,
    billableMs: 0,
    expertFirstJoinedAt: new Date('2026-08-14T10:00:00.000Z'),
    billableStartedAt: null,
  },
  asOf: '2026-08-14T10:05:00.000Z',
  noShowFloorMinutes: 15,
  presence: { expertOpen: true },
};

describe('GET /meetings/:meetingId/state (BAL-134 §7.1)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    app.setErrorHandler((_error, _request, reply) => {
      reply.status(500).send({ error: 'Internal Server Error' });
    });
    await app.register(meetingStateRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({ allowed: true, current: 1, ttlSeconds: 3600 });
    mockResolveTimers.mockReturnValue(TIMERS);
    mockGetMeetingState.mockResolvedValue({ ok: true, state: STATE });
  });

  async function call(opts: InjectOptions): Promise<LightMyRequestResponse> {
    return app.inject(opts);
  }

  it('REQUIRES a Bearer — 401 without one', async () => {
    const res = await call({ method: 'GET', url: URL });

    expect(res.statusCode).toBe(401);
    expect(mockGetMeetingState).not.toHaveBeenCalled();
  });

  it('400 on a non-uuid meeting id', async () => {
    const res = await call({ method: 'GET', url: '/meetings/not-a-uuid/state', headers: AUTH });

    expect(res.statusCode).toBe(400);
    expect(mockGetMeetingState).not.toHaveBeenCalled();
  });

  it('200 with the state payload', async () => {
    const res = await call({ method: 'GET', url: URL, headers: AUTH });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'waiting_for_participants',
      viewerRole: 'expert',
      phase: 'near',
      asOf: STATE.asOf,
    });
  });

  /**
   * ⚠⚠ THE PAYLOAD CARRIES NO CREDENTIAL AND NO MONEY. This is a POLLED endpoint reachable from
   * a browser every ten seconds; a `token`, a `roomUrl` or a price sneaking onto it would be a
   * credential or a fee leak repeated 360 times an hour.
   */
  it('⚠⚠ carries no token, no roomUrl, no participantId and no money figure', async () => {
    const res = await call({ method: 'GET', url: URL, headers: AUTH });
    const keys = Object.keys(res.json() as Record<string, unknown>);

    for (const forbidden of ['token', 'roomUrl', 'participantId', 'amount', 'priceCents', 'fee']) {
      expect(keys).not.toContain(forbidden);
    }
  });

  /**
   * ⚠ THE PHASE IS SERVER-COMPUTED AND THE ENV-RESOLVED TIMERS ARE WHAT MAKE THAT TRUE. If the
   * route stopped passing them, an overridden server and a default-carrying browser bundle would
   * disagree silently — the exact drift D8 exists to prevent.
   */
  it('⚠ passes the ENV-RESOLVED timers into the read', async () => {
    await call({ method: 'GET', url: URL, headers: AUTH });

    expect(mockGetMeetingState).toHaveBeenCalledWith({
      meetingId: MEETING_ID,
      userId: USER_ID,
      timers: TIMERS,
    });
  });

  /**
   * ⚠ THE ROUTE FORWARDS THE READ'S VIEW **VERBATIM**. Both fields are the browser's only source
   * for the no-show sentence and the amber "counted" chip; a route that reshaped or dropped them
   * would silently put the web side back on its deploy-skew fallbacks — a hard-coded threshold
   * and an "ever joined" chip — with every other assertion in this file still green.
   */
  it('⚠ forwards `noShowFloorMinutes` and `presence.expertOpen` onto the wire', async () => {
    const res = await call({ method: 'GET', url: URL, headers: AUTH });

    expect(res.json()).toMatchObject({
      noShowFloorMinutes: 15,
      presence: { expertOpen: true },
    });
  });

  /**
   * ⚠⚠ THE ENV OVERRIDE REALLY REACHES THE READ — asserted against the **REAL**
   * `resolveMeetingTimers`, not the stub the rest of this file uses.
   *
   * The stub proves the route passes *something*; only the real resolver proves that
   * `MEETING_NO_SHOW_FLOOR_MINUTES` is what ends up in the payload the browser interpolates. That
   * is the whole chain D8 exists to keep honest: env → resolver → read → wire → sentence.
   */
  it('⚠⚠ an ENV override on the no-show floor reaches the read', async () => {
    const actual = await vi.importActual<typeof import('../../config/meeting-timers.js')>(
      '../../config/meeting-timers.js'
    );
    const previous = process.env.MEETING_NO_SHOW_FLOOR_MINUTES;
    process.env.MEETING_NO_SHOW_FLOOR_MINUTES = '25';
    mockResolveTimers.mockImplementation(actual.resolveMeetingTimers);

    try {
      await call({ method: 'GET', url: URL, headers: AUTH });

      expect(mockGetMeetingState).toHaveBeenCalledWith(
        expect.objectContaining({
          timers: expect.objectContaining({ noShowFloorMs: 25 * 60_000 }),
        })
      );
    } finally {
      // ⚠ RESTORED EXACTLY, INCLUDING "WAS UNSET" — leaking this variable would silently change
      // the timers every later test in this process resolves.
      if (previous === undefined) {
        delete process.env.MEETING_NO_SHOW_FLOOR_MINUTES;
      } else {
        process.env.MEETING_NO_SHOW_FLOOR_MINUTES = previous;
      }
    }
  });

  it('404 on every denial — no 403, matching the family', async () => {
    mockGetMeetingState.mockResolvedValue({ ok: false, code: 'meeting_not_found' });

    const res = await call({ method: 'GET', url: URL, headers: AUTH });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'meeting_not_found' });
  });

  it('429 with Retry-After when the per-user window is exhausted', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, current: 1201, ttlSeconds: 120 });

    const res = await call({ method: 'GET', url: URL, headers: AUTH });

    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('120');
    expect(mockGetMeetingState).not.toHaveBeenCalled();
  });

  /**
   * ⚠⚠ FAILS **OPEN**, DELIBERATELY THE OPPOSITE OF `POST /meetings` AND `POST /:id/end`. Those
   * WRITE, so an unmetered window during a Redis outage is exactly what an attacker waits for.
   * This is a READ a browser polls DURING A LIVE CALL: failing it closed would freeze every
   * participant's mirror the moment Redis hiccuped.
   */
  it('⚠⚠ fails OPEN on a Redis error — a read path during a live call', async () => {
    mockCheckRateLimit.mockRejectedValue(new Error('redis down'));

    const res = await call({ method: 'GET', url: URL, headers: AUTH });

    expect(res.statusCode).toBe(200);
    expect(mockGetMeetingState).toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'redis down' }),
      expect.stringContaining('failing OPEN')
    );
  });

  /**
   * ⚠ KEYED PER USER, NOT PER IP. Every request arrives through `apps/web`'s server-side fetch,
   * so an IP key would put the whole platform's in-call polling in ONE bucket — the same mistake
   * `join.ts` records for the guest poll.
   */
  it('⚠ the rate-limit key is the USER id', async () => {
    await call({ method: 'GET', url: URL, headers: AUTH });

    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ keyPrefix: 'ratelimit:meeting-state:user' }),
      USER_ID
    );
  });
});
