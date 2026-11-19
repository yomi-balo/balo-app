import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  loadGates: vi.fn(),
  startCallNow: vi.fn(),
  answerCallNow: vi.fn(),
  sendJoinError: vi.fn(),
  sendMemberJoinGrant: vi.fn(),
  endRing: vi.fn(),
  findById: vi.fn(),
  findMeeting: vi.fn(),
  checkRateLimit: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: mocks.logError,
  }),
}));
// `findByIdForParty` filters on identity IN THE QUERY; the stand-in applies the same WHERE to
// the row `findById` hands it, so a stranger's read is a miss exactly as in Postgres.
vi.mock('@balo/db', () => ({
  meetingsRepository: { findById: mocks.findMeeting },
  meetingRingsRepository: {
    findByIdForParty: async (ringId: string, userId: string) => {
      const row = (await mocks.findById(ringId, userId)) as
        | { callerUserId: string; calleeUserId: string }
        | undefined;
      return row !== undefined && (row.callerUserId === userId || row.calleeUserId === userId)
        ? row
        : undefined;
    },
  },
}));
vi.mock('../../lib/rate-limiter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/rate-limiter.js')>()),
  checkRateLimit: mocks.checkRateLimit,
}));
vi.mock('../../lib/redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('../../lib/require-auth.js', () => ({
  requireAuth: async (request: { userId?: string; headers: Record<string, unknown> }) => {
    if (typeof request.headers.authorization !== 'string') return;
    request.userId = USER_ID;
  },
}));
vi.mock('../../services/call-now/authorize-call-now.js', () => ({
  authorizeCallNow: mocks.authorize,
}));
vi.mock('../../services/call-now/call-now-gates.js', () => ({ loadCallNowGates: mocks.loadGates }));
vi.mock('../../services/call-now/start-call.js', () => ({ startCallNow: mocks.startCallNow }));
vi.mock('../../services/call-now/end-ring.js', () => ({ endRing: mocks.endRing }));
vi.mock('../../services/call-now/answer-call.js', () => ({ answerCallNow: mocks.answerCallNow }));
// The funding guard's own behaviour is `case-booking-funding.test.ts`; the route needs its status map.
vi.mock('../../services/meetings/case-booking-funding.js', () => ({
  CASE_BOOKING_FUNDING_STATUS: {
    account_on_hold: 409,
    booking_unfunded: 409,
    booking_reserved: 409,
    booking_funding_unavailable: 503,
  },
}));
// The join route's senders have their own tests (`routes/meetings/join.test.ts`).
vi.mock('../meetings/join.js', () => ({
  sendJoinError: mocks.sendJoinError,
  sendMemberJoinGrant: mocks.sendMemberJoinGrant,
}));

import Fastify, { type FastifyInstance } from 'fastify';
import { callNowRoutes } from './index.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const ENGAGEMENT_ID = '33333333-3333-4333-8333-333333333333';
const MEETING_ID = '44444444-4444-4444-8444-444444444444';
const RING_ID = '88888888-8888-4888-8888-888888888888';
const ATTEMPT_ID = '99999999-9999-4999-8999-999999999999';
const AUTH = { authorization: 'Bearer t' };
const EXPIRES = new Date('2026-11-16T10:00:45.000Z');

function ring(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RING_ID,
    meetingId: MEETING_ID,
    engagementId: ENGAGEMENT_ID,
    callerUserId: USER_ID,
    calleeUserId: OTHER_USER,
    status: 'ringing',
    placement: 'new_meeting',
    callerSide: 'client',
    reachedBy: 'app',
    attemptId: ATTEMPT_ID,
    calleeOnlineAtStart: false,
    expiresAt: EXPIRES,
    ...overrides,
  };
}

describe('call-now routes (BAL-649)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(callNowRoutes);
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkRateLimit.mockResolvedValue({ allowed: true, ttlSeconds: 0 });
    mocks.authorize.mockResolvedValue({
      ok: true,
      side: 'client',
      caseRow: { id: ENGAGEMENT_ID },
      mayRing: true,
    });
    mocks.loadGates.mockResolvedValue({
      availability: { canCallNow: true },
      callee: { userId: OTHER_USER, timeZone: 'Australia/Sydney' },
      calleeOnline: false,
      inPlaceCandidate: null,
    });
    mocks.findById.mockResolvedValue(ring());
    mocks.endRing.mockResolvedValue({ ended: true, status: 'declined' });
  });

  describe('GET /cases/:engagementId/call-now', () => {
    const url = `/cases/${ENGAGEMENT_ID}/call-now`;

    it('401 without auth', async () => {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(401);
      expect(mocks.authorize).not.toHaveBeenCalled();
    });

    it('400 for a malformed id', async () => {
      const res = await app.inject({ method: 'GET', url: '/cases/nope/call-now', headers: AUTH });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid_request' });
    });

    it('404 case_not_found when unauthorized', async () => {
      mocks.authorize.mockResolvedValue({ ok: false, code: 'case_not_found' });

      const res = await app.inject({ method: 'GET', url, headers: AUTH });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: 'case_not_found', code: 'case_not_found' });
      expect(mocks.loadGates).not.toHaveBeenCalled();
    });

    it('200 canCallNow with a null reason and ISO candidate', async () => {
      mocks.loadGates.mockResolvedValue({
        availability: { canCallNow: true },
        callee: { userId: OTHER_USER, timeZone: 'Australia/Sydney' },
        calleeOnline: true,
        inPlaceCandidate: {
          meetingId: MEETING_ID,
          scheduledStart: new Date('2026-11-16T15:00:00.000Z'),
        },
      });

      const res = await app.inject({ method: 'GET', url, headers: AUTH });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        canCallNow: true,
        reason: null,
        calleeOnline: true,
        calleeTimeZone: null,
        inPlaceCandidate: { meetingId: MEETING_ID, scheduledStart: '2026-11-16T15:00:00.000Z' },
      });
    });

    it('⚠ calleeOnline is real only when the caller is the client (the callee is the expert)', async () => {
      mocks.loadGates.mockResolvedValue({
        availability: { canCallNow: true },
        callee: { userId: OTHER_USER, timeZone: 'Australia/Sydney' },
        calleeOnline: true,
        inPlaceCandidate: null,
      });

      mocks.authorize.mockResolvedValue({
        ok: true,
        side: 'client',
        caseRow: { id: ENGAGEMENT_ID },
        mayRing: true,
      });
      const clientRes = await app.inject({ method: 'GET', url, headers: AUTH });
      expect(clientRes.json()).toMatchObject({ calleeOnline: true });

      mocks.authorize.mockResolvedValue({
        ok: true,
        side: 'expert',
        caseRow: { id: ENGAGEMENT_ID },
        mayRing: true,
      });
      const expertRes = await app.inject({ method: 'GET', url, headers: AUTH });
      expect(expertRes.json()).toMatchObject({ calleeOnline: false });
    });

    it('200 with the display reason, and never the internal refusal', async () => {
      mocks.loadGates.mockResolvedValue({
        availability: { canCallNow: false, refusal: 'callee_busy', reason: 'busy' },
        callee: { userId: OTHER_USER, timeZone: 'Australia/Sydney' },
        calleeOnline: false,
        inPlaceCandidate: null,
      });

      const res = await app.inject({ method: 'GET', url, headers: AUTH });

      expect(res.json()).toEqual({
        canCallNow: false,
        reason: 'busy',
        calleeOnline: false,
        calleeTimeZone: null,
        inPlaceCandidate: null,
      });
      expect(res.body).not.toContain('callee_busy');
    });

    it('carries the callee zone only for an outside_hours refusal', async () => {
      mocks.loadGates.mockResolvedValue({
        availability: {
          canCallNow: false,
          refusal: 'expert_outside_hours',
          reason: 'outside_hours',
        },
        callee: { userId: OTHER_USER, timeZone: 'Australia/Sydney' },
        calleeOnline: false,
        inPlaceCandidate: null,
      });

      const res = await app.inject({ method: 'GET', url, headers: AUTH });

      expect(res.json()).toMatchObject({
        reason: 'outside_hours',
        calleeTimeZone: 'Australia/Sydney',
      });
      expect(res.body).not.toContain('expert_outside_hours');
    });

    it('calleeTimeZone is null for outside_hours when no callee resolved', async () => {
      mocks.loadGates.mockResolvedValue({
        availability: {
          canCallNow: false,
          refusal: 'expert_outside_hours',
          reason: 'outside_hours',
        },
        callee: null,
        calleeOnline: false,
        inPlaceCandidate: null,
      });

      const res = await app.inject({ method: 'GET', url, headers: AUTH });

      expect(res.json()).toMatchObject({ reason: 'outside_hours', calleeTimeZone: null });
    });

    it('passes `mayRing` from the authorization into the gates', async () => {
      mocks.authorize.mockResolvedValue({
        ok: true,
        side: 'expert',
        caseRow: { id: ENGAGEMENT_ID },
        mayRing: false,
      });

      await app.inject({ method: 'GET', url, headers: AUTH });

      expect(mocks.loadGates).toHaveBeenCalledWith(
        expect.objectContaining({ side: 'expert', mayRing: false, userId: USER_ID })
      );
    });

    it('429 on the view bucket, before any read — the view is not a free busy-probe', async () => {
      mocks.checkRateLimit.mockResolvedValue({ allowed: false, ttlSeconds: 9 });

      const res = await app.inject({ method: 'GET', url, headers: AUTH });

      expect(res.statusCode).toBe(429);
      expect(mocks.authorize).not.toHaveBeenCalled();
      expect(mocks.checkRateLimit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ keyPrefix: 'ratelimit:call-now-view', maxRequests: 120 }),
        USER_ID
      );
    });

    it('500 internal_error with a log.error when a read fails', async () => {
      mocks.loadGates.mockRejectedValue(new Error('db down'));

      const res = await app.inject({ method: 'GET', url, headers: AUTH });

      expect(res.statusCode).toBe(500);
      expect(res.json()).toMatchObject({ code: 'internal_error' });
      expect(res.body).not.toContain('db down');
      expect(mocks.logError).toHaveBeenCalled();
    });
  });

  describe('POST /cases/:engagementId/call-now', () => {
    const url = `/cases/${ENGAGEMENT_ID}/call-now`;
    const post = (payload: unknown = {}) =>
      app.inject({ method: 'POST', url, headers: AUTH, payload: payload as object });

    it('401 without auth', async () => {
      const res = await app.inject({ method: 'POST', url, payload: {} });
      expect(res.statusCode).toBe(401);
    });

    it('201 with the ring, meeting, placement and ISO expiry', async () => {
      mocks.startCallNow.mockResolvedValue({
        ok: true,
        ringId: RING_ID,
        meetingId: MEETING_ID,
        placement: 'new_meeting',
        expiresAt: EXPIRES,
      });

      const res = await post();

      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({
        ringId: RING_ID,
        meetingId: MEETING_ID,
        placement: 'new_meeting',
        expiresAt: EXPIRES.toISOString(),
      });
      expect(mocks.startCallNow).toHaveBeenCalledWith(
        expect.objectContaining({
          engagementId: ENGAGEMENT_ID,
          userId: USER_ID,
          meterCallee: expect.any(Function),
          releaseCallee: expect.any(Function),
        })
      );
    });

    describe('?attemptId (BAL-651)', () => {
      const started = {
        ok: true,
        ringId: RING_ID,
        meetingId: MEETING_ID,
        placement: 'new_meeting',
        expiresAt: EXPIRES,
      };

      it('threads a valid attempt id to the service', async () => {
        mocks.startCallNow.mockResolvedValue(started);

        const res = await app.inject({
          method: 'POST',
          url: `${url}?attemptId=${ATTEMPT_ID}`,
          headers: AUTH,
          payload: {},
        });

        expect(res.statusCode).toBe(201);
        expect(mocks.startCallNow).toHaveBeenCalledWith(
          expect.objectContaining({ attemptId: ATTEMPT_ID })
        );
      });

      it('drops a malformed attempt id to undefined, never a 400', async () => {
        mocks.startCallNow.mockResolvedValue(started);

        const res = await app.inject({
          method: 'POST',
          url: `${url}?attemptId=not-a-uuid`,
          headers: AUTH,
          payload: {},
        });

        expect(res.statusCode).toBe(201);
        expect(mocks.startCallNow).toHaveBeenCalledWith(
          expect.objectContaining({ attemptId: undefined })
        );
      });

      it('ignores an unknown query parameter', async () => {
        mocks.startCallNow.mockResolvedValue(started);

        const res = await app.inject({
          method: 'POST',
          url: `${url}?side=expert`,
          headers: AUTH,
          payload: {},
        });

        expect(res.statusCode).toBe(201);
      });

      it('sends no attempt id when the query carries none (an older web build)', async () => {
        mocks.startCallNow.mockResolvedValue(started);

        await post();

        expect(mocks.startCallNow).toHaveBeenCalledWith(
          expect.objectContaining({ attemptId: undefined })
        );
      });

      it('keeps the body strict: an attempt id in the body is a 400', async () => {
        const res = await post({ attemptId: ATTEMPT_ID });

        expect(res.statusCode).toBe(400);
        expect(mocks.startCallNow).not.toHaveBeenCalled();
      });
    });

    it('threads `inPlaceOfMeetingId` to the service', async () => {
      mocks.startCallNow.mockResolvedValue({
        ok: true,
        ringId: RING_ID,
        meetingId: MEETING_ID,
        placement: 'in_place',
        expiresAt: EXPIRES,
      });

      await post({ inPlaceOfMeetingId: MEETING_ID });

      expect(mocks.startCallNow).toHaveBeenCalledWith(
        expect.objectContaining({ inPlaceOfMeetingId: MEETING_ID })
      );
    });

    it.each([
      ['an unknown key', { side: 'expert' }],
      ['a non-uuid meeting id', { inPlaceOfMeetingId: 'nope' }],
    ])('400 for %s (the body is strict)', async (_label, payload) => {
      const res = await post(payload);

      expect(res.statusCode).toBe(400);
      expect(mocks.startCallNow).not.toHaveBeenCalled();
    });

    it('404 case_not_found', async () => {
      mocks.startCallNow.mockResolvedValue({ ok: false, code: 'case_not_found' });

      const res = await post();

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: 'case_not_found' });
    });

    it('409 call_now_unavailable carries only the display reason', async () => {
      mocks.startCallNow.mockResolvedValue({
        ok: false,
        code: 'call_now_unavailable',
        refusal: 'outside_hours',
        reason: 'outside_hours',
      });

      const res = await post();

      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        error: 'call_now_unavailable',
        code: 'call_now_unavailable',
        reason: 'outside_hours',
      });
    });

    it('409 with a null reason for a gate the UI hides', async () => {
      mocks.startCallNow.mockResolvedValue({
        ok: false,
        code: 'call_now_unavailable',
        refusal: 'ring_in_progress',
        reason: null,
      });

      const res = await post();

      expect(res.json()).toMatchObject({ code: 'call_now_unavailable', reason: null });
      expect(res.body).not.toContain('ring_in_progress');
    });

    it('400 in_place_not_allowed (an expert caller sent `inPlaceOfMeetingId`, decision 9)', async () => {
      mocks.startCallNow.mockResolvedValue({ ok: false, code: 'in_place_not_allowed' });

      const res = await post({ inPlaceOfMeetingId: MEETING_ID });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'in_place_not_allowed' });
    });

    it.each([
      { kind: 'company', id: 'company-1' },
      { kind: 'expert_profile', id: 'expert-profile-1' },
    ] as const)(
      'meters the CALLEE per calling party ($kind): ≤ 6 rings per (callee, party) per 10 minutes',
      async (callingParty) => {
        mocks.checkRateLimit
          .mockResolvedValueOnce({ allowed: true, ttlSeconds: 0 })
          .mockResolvedValueOnce({ allowed: false, ttlSeconds: 77 });
        mocks.startCallNow.mockImplementation(
          async (input: {
            meterCallee: (
              calleeUserId: string,
              party: { kind: string; id: string }
            ) => Promise<boolean>;
          }) =>
            (await input.meterCallee(OTHER_USER, callingParty))
              ? { ok: false, code: 'rate_limited' }
              : { ok: false, code: 'case_not_found' }
        );

        const res = await post();

        expect(res.statusCode).toBe(429);
        expect(res.headers['retry-after']).toBe('77');
        expect(mocks.checkRateLimit).toHaveBeenLastCalledWith(
          expect.anything(),
          expect.objectContaining({
            keyPrefix: 'ratelimit:call-now-callee',
            maxRequests: 6,
            windowSeconds: 600,
          }),
          `${OTHER_USER}:${callingParty.kind}:${callingParty.id}`
        );
      }
    );

    it.each([
      ['account_on_hold', 4_200],
      ['booking_unfunded', 12_500],
      ['booking_reserved', 30_000],
      ['booking_funding_unavailable', null],
    ] as const)('⚠ a %s refusal is fee-concealed: its exact key set', async (code, figure) => {
      mocks.startCallNow.mockResolvedValue({ ok: false, code, suggestedTopUpMinor: figure });

      const res = await post();

      if (code === 'booking_funding_unavailable') {
        expect(res.statusCode).toBe(503);
        expect(res.json()).toEqual({ error: code, code });
        return;
      }
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: code, code, suggestedTopUpMinor: figure });
    });

    it('a funding refusal with no meaningful figure carries suggestedTopUpMinor: null', async () => {
      mocks.startCallNow.mockResolvedValue({
        ok: false,
        code: 'account_on_hold',
        suggestedTopUpMinor: null,
      });

      const res = await post();

      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        error: 'account_on_hold',
        code: 'account_on_hold',
        suggestedTopUpMinor: null,
      });
    });

    it('409 in_place_not_eligible', async () => {
      mocks.startCallNow.mockResolvedValue({ ok: false, code: 'in_place_not_eligible' });

      const res = await post({ inPlaceOfMeetingId: MEETING_ID });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'in_place_not_eligible' });
    });

    it('503 venue_unavailable', async () => {
      mocks.startCallNow.mockResolvedValue({ ok: false, code: 'venue_unavailable' });

      const res = await post();

      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ code: 'venue_unavailable' });
    });

    it('429 when rate-limited, before any service call', async () => {
      mocks.checkRateLimit.mockResolvedValue({ allowed: false, ttlSeconds: 42 });

      const res = await post();

      expect(res.statusCode).toBe(429);
      expect(res.headers['retry-after']).toBe('42');
      expect(mocks.startCallNow).not.toHaveBeenCalled();
      expect(mocks.checkRateLimit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ keyPrefix: 'ratelimit:call-now-start', maxRequests: 10 }),
        USER_ID
      );
    });

    it('503 rate_limit_unavailable when the limiter fails (fail-closed)', async () => {
      mocks.checkRateLimit.mockRejectedValue(new Error('redis down'));

      const res = await post();

      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'rate_limit_unavailable' });
      expect(mocks.startCallNow).not.toHaveBeenCalled();
    });

    it('500 internal_error with a log.error on an unexpected throw', async () => {
      mocks.startCallNow.mockRejectedValue(new Error('boom'));

      const res = await post();

      expect(res.statusCode).toBe(500);
      expect(res.json()).toMatchObject({ code: 'internal_error' });
      expect(res.body).not.toContain('boom');
      expect(mocks.logError).toHaveBeenCalledWith(
        expect.objectContaining({ engagementId: ENGAGEMENT_ID, error: 'boom' }),
        expect.any(String)
      );
    });
  });

  describe('POST /call-now/rings/:ringId/answer (BAL-650)', () => {
    const url = `/call-now/rings/${RING_ID}/answer`;
    const answer = () => app.inject({ method: 'POST', url, headers: AUTH });
    const JOIN = { grant: { token: 'daily.jwt' } };

    it('401 without auth, 400 for a bad ring id', async () => {
      expect((await app.inject({ method: 'POST', url })).statusCode).toBe(401);
      expect(
        (await app.inject({ method: 'POST', url: '/call-now/rings/x/answer', headers: AUTH }))
          .statusCode
      ).toBe(400);
      expect(mocks.answerCallNow).not.toHaveBeenCalled();
    });

    it('answers the client commit with the member join grant', async () => {
      mocks.answerCallNow.mockResolvedValue({ ok: true, join: JOIN });
      mocks.sendMemberJoinGrant.mockImplementation(
        (reply: { code: (n: number) => { send: (b: unknown) => void } }) =>
          reply.code(200).send({ token: 'daily.jwt' })
      );

      const res = await answer();

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ token: 'daily.jwt' });
      expect(mocks.answerCallNow).toHaveBeenCalledWith({ ringId: RING_ID, userId: USER_ID });
      expect(mocks.sendMemberJoinGrant).toHaveBeenCalledWith(expect.anything(), JOIN);
    });

    it('404 ring_not_found — an expert caller, a stranger and an unknown ring read alike', async () => {
      mocks.answerCallNow.mockResolvedValue({ ok: false, code: 'ring_not_found' });

      const res = await answer();

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'ring_not_found', code: 'ring_not_found' });
    });

    it('409 ring_not_ringing carries the ring’s current status', async () => {
      mocks.answerCallNow.mockResolvedValue({
        ok: false,
        code: 'ring_not_ringing',
        status: 'connected',
      });

      const res = await answer();

      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        error: 'ring_not_ringing',
        code: 'ring_not_ringing',
        status: 'connected',
      });
    });

    it.each([
      ['account_on_hold', 4_200],
      ['booking_unfunded', 12_500],
      ['booking_reserved', 30_000],
    ] as const)(
      '⚠ 409 %s is fee-concealed: exactly { error, code, suggestedTopUpMinor }',
      async (code, figure) => {
        mocks.answerCallNow.mockResolvedValue({ ok: false, code, suggestedTopUpMinor: figure });

        const res = await answer();

        expect(res.statusCode).toBe(409);
        expect(Object.keys(res.json()).sort((a, b) => a.localeCompare(b))).toEqual([
          'code',
          'error',
          'suggestedTopUpMinor',
        ]);
        expect(res.json()).toMatchObject({ error: code, suggestedTopUpMinor: figure });
      }
    );

    it('⚠ 503 booking_funding_unavailable carries no figure at all', async () => {
      mocks.answerCallNow.mockResolvedValue({
        ok: false,
        code: 'booking_funding_unavailable',
        suggestedTopUpMinor: null,
      });

      const res = await answer();

      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({
        error: 'booking_funding_unavailable',
        code: 'booking_funding_unavailable',
      });
    });

    it('a refused join after a passed check goes through the join route’s error sender', async () => {
      const failure = { ok: false, code: 'meeting_not_open_for_join' };
      mocks.answerCallNow.mockResolvedValue({ ok: false, code: 'join_failed', failure });
      mocks.sendJoinError.mockImplementation(
        (reply: { code: (n: number) => { send: (b: unknown) => void } }) =>
          reply.code(409).send({ error: 'meeting_not_open_for_join' })
      );

      const res = await answer();

      expect(res.statusCode).toBe(409);
      expect(mocks.sendJoinError).toHaveBeenCalledWith(
        expect.anything(),
        failure,
        expect.objectContaining({ ringId: RING_ID, userId: USER_ID })
      );
    });

    it('429 on the ring-action bucket, before any service call', async () => {
      mocks.checkRateLimit.mockResolvedValue({ allowed: false, ttlSeconds: 5 });

      const res = await answer();

      expect(res.statusCode).toBe(429);
      expect(mocks.answerCallNow).not.toHaveBeenCalled();
    });

    it('500 internal_error with a log.error on an unexpected throw', async () => {
      mocks.answerCallNow.mockRejectedValue(new Error('boom'));

      const res = await answer();

      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain('boom');
      expect(mocks.logError).toHaveBeenCalledWith(
        expect.objectContaining({ ringId: RING_ID, error: 'boom' }),
        'Call now answer failed'
      );
    });
  });

  describe('GET /call-now/rings/:ringId', () => {
    const url = `/call-now/rings/${RING_ID}`;

    it('200 to the caller with role `caller`, read by id AND identity', async () => {
      const res = await app.inject({ method: 'GET', url, headers: AUTH });

      expect(mocks.findById).toHaveBeenCalledWith(RING_ID, USER_ID);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        ringId: RING_ID,
        meetingId: MEETING_ID,
        engagementId: ENGAGEMENT_ID,
        status: 'ringing',
        placement: 'new_meeting',
        expiresAt: EXPIRES.toISOString(),
        role: 'caller',
        reachedBy: 'app',
        awaitsAnswer: false,
        meetingEnded: false,
        attemptId: ATTEMPT_ID,
        calleePresenceAtStart: 'offline',
      });
    });

    it('carries the attempt id and an online start to a client caller only', async () => {
      mocks.findById.mockResolvedValue(ring({ calleeOnlineAtStart: true }));

      const res = await app.inject({ method: 'GET', url, headers: AUTH });

      expect(res.json()).toMatchObject({ attemptId: ATTEMPT_ID, calleePresenceAtStart: 'online' });
    });

    it('masks an expert caller’s callee presence to offline, whatever the stored value', async () => {
      mocks.findById.mockResolvedValue(ring({ callerSide: 'expert', calleeOnlineAtStart: true }));

      const res = await app.inject({ method: 'GET', url, headers: AUTH });

      expect(res.json()).toMatchObject({ attemptId: ATTEMPT_ID, calleePresenceAtStart: 'offline' });
    });

    it('hands the callee neither the attempt id nor the presence', async () => {
      mocks.findById.mockResolvedValue(
        ring({ callerUserId: OTHER_USER, calleeUserId: USER_ID, calleeOnlineAtStart: true })
      );

      const res = await app.inject({ method: 'GET', url, headers: AUTH });

      expect(res.json()).toMatchObject({
        role: 'callee',
        attemptId: null,
        calleePresenceAtStart: null,
      });
    });

    it('answers a null attempt id for a ring started before the column existed', async () => {
      mocks.findById.mockResolvedValue(ring({ attemptId: null, calleeOnlineAtStart: null }));

      const res = await app.inject({ method: 'GET', url, headers: AUTH });

      expect(res.json()).toMatchObject({ attemptId: null, calleePresenceAtStart: 'offline' });
    });

    it('carries how the callee was reached', async () => {
      mocks.findById.mockResolvedValue(ring({ reachedBy: 'sms' }));

      const res = await app.inject({ method: 'GET', url, headers: AUTH });

      expect(res.json()).toMatchObject({ reachedBy: 'sms' });
    });

    it('200 to the callee with role `callee`', async () => {
      mocks.findById.mockResolvedValue(ring({ callerUserId: OTHER_USER, calleeUserId: USER_ID }));

      const res = await app.inject({ method: 'GET', url, headers: AUTH });

      expect(res.json()).toMatchObject({ role: 'callee' });
    });

    it.each([
      ['an expert-started new_meeting ring the callee has not answered', 'callee', {}, true],
      ['the caller of that ring', 'caller', {}, false],
      ['an in_place ring', 'callee', { placement: 'in_place' }, false],
      ['a client-started ring', 'callee', { callerSide: 'client' }, false],
      ['a connected expert-started ring', 'callee', { status: 'connected' }, false],
    ] as const)('awaitsAnswer for %s', async (_label, role, overrides, expected) => {
      const parties =
        role === 'callee'
          ? { callerUserId: OTHER_USER, calleeUserId: USER_ID }
          : { callerUserId: USER_ID, calleeUserId: OTHER_USER };
      mocks.findMeeting.mockResolvedValue({ status: 'in_progress' });
      mocks.findById.mockResolvedValue(ring({ callerSide: 'expert', ...parties, ...overrides }));

      const res = await app.inject({ method: 'GET', url, headers: AUTH });

      expect(res.json()).toMatchObject({ awaitsAnswer: expected });
    });

    it.each([
      ['ended', true],
      ['cancelled', true],
      ['in_progress', false],
      ['scheduled', false],
    ])('meetingEnded is %s→%s for a connected ring', async (status, expected) => {
      mocks.findMeeting.mockResolvedValue({ status });
      mocks.findById.mockResolvedValue(ring({ status: 'connected' }));

      const res = await app.inject({ method: 'GET', url, headers: AUTH });

      expect(mocks.findMeeting).toHaveBeenCalledWith(MEETING_ID);
      expect(res.json()).toMatchObject({ meetingEnded: expected });
    });

    it('meetingEnded is true for a connected ring whose meeting is gone', async () => {
      mocks.findMeeting.mockResolvedValue(undefined);
      mocks.findById.mockResolvedValue(ring({ status: 'connected' }));

      const res = await app.inject({ method: 'GET', url, headers: AUTH });

      expect(res.json()).toMatchObject({ meetingEnded: true });
    });

    it.each(['ringing', 'unanswered', 'declined', 'stopped'])(
      'does not read the meeting for a %s ring',
      async (status) => {
        mocks.findById.mockResolvedValue(ring({ status }));

        const res = await app.inject({ method: 'GET', url, headers: AUTH });

        expect(mocks.findMeeting).not.toHaveBeenCalled();
        expect(res.json()).toMatchObject({ meetingEnded: false });
      }
    );

    it('404 ring_not_found for a stranger and for an unknown ring alike', async () => {
      mocks.findById.mockResolvedValueOnce(
        ring({ callerUserId: OTHER_USER, calleeUserId: OTHER_USER })
      );
      const stranger = await app.inject({ method: 'GET', url, headers: AUTH });
      mocks.findById.mockResolvedValueOnce(undefined);
      const unknown = await app.inject({ method: 'GET', url, headers: AUTH });

      expect(stranger.statusCode).toBe(404);
      expect(unknown.statusCode).toBe(404);
      expect(stranger.json()).toEqual(unknown.json());
    });

    it('401 without auth, 400 for a bad id, 500 on a read failure', async () => {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
      expect(
        (await app.inject({ method: 'GET', url: '/call-now/rings/x', headers: AUTH })).statusCode
      ).toBe(400);
      mocks.findById.mockRejectedValue(new Error('db'));
      expect((await app.inject({ method: 'GET', url, headers: AUTH })).statusCode).toBe(500);
    });
  });

  describe.each([
    ['decline', 'callee', 'declined'],
    ['stop', 'caller', 'stopped'],
  ] as const)('POST /call-now/rings/:ringId/%s', (action, role, to) => {
    const url = `/call-now/rings/${RING_ID}/${action}`;
    const actor = ring(
      role === 'callee' ? { callerUserId: OTHER_USER, calleeUserId: USER_ID } : {}
    );
    const wrongSide = ring(
      role === 'callee'
        ? { callerUserId: USER_ID, calleeUserId: OTHER_USER }
        : { callerUserId: OTHER_USER, calleeUserId: USER_ID }
    );

    it(`ends the ring as ${to} for the ${role}, attributing the actor`, async () => {
      mocks.findById.mockResolvedValue(actor);
      mocks.endRing.mockResolvedValue({ ended: true, status: to });

      const res = await app.inject({ method: 'POST', url, headers: AUTH });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: to });
      expect(mocks.endRing).toHaveBeenCalledWith({
        ringId: RING_ID,
        to,
        actorUserId: USER_ID,
        now: expect.any(Date),
      });
    });

    it('404 ring_not_found for the OTHER party of the ring (identity match)', async () => {
      mocks.findById.mockResolvedValue(wrongSide);

      const res = await app.inject({ method: 'POST', url, headers: AUTH });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: 'ring_not_found' });
      expect(mocks.endRing).not.toHaveBeenCalled();
    });

    it('404 for an unknown ring', async () => {
      mocks.findById.mockResolvedValue(undefined);

      expect((await app.inject({ method: 'POST', url, headers: AUTH })).statusCode).toBe(404);
    });

    it('200 with the CURRENT status when the compare-and-set was lost (after connect)', async () => {
      mocks.findById.mockResolvedValue(actor);
      mocks.endRing.mockResolvedValue({ ended: false, status: 'connected' });

      const res = await app.inject({ method: 'POST', url, headers: AUTH });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'connected' });
    });

    it('200 with the row’s status when the ring vanished between the read and the end', async () => {
      mocks.findById.mockResolvedValue(actor);
      mocks.endRing.mockResolvedValue({ ended: false, status: null });

      const res = await app.inject({ method: 'POST', url, headers: AUTH });

      expect(res.json()).toEqual({ status: 'ringing' });
    });

    it('401 without auth', async () => {
      expect((await app.inject({ method: 'POST', url })).statusCode).toBe(401);
    });

    it('429 on the ring-action bucket, before any read', async () => {
      mocks.checkRateLimit.mockResolvedValue({ allowed: false, ttlSeconds: 5 });

      const res = await app.inject({ method: 'POST', url, headers: AUTH });

      expect(res.statusCode).toBe(429);
      expect(mocks.findById).not.toHaveBeenCalled();
      expect(mocks.checkRateLimit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ keyPrefix: 'ratelimit:call-now-ring', maxRequests: 30 }),
        USER_ID
      );
    });

    it('500 internal_error with a log.error', async () => {
      mocks.findById.mockResolvedValue(actor);
      mocks.endRing.mockRejectedValue(new Error('db'));

      const res = await app.inject({ method: 'POST', url, headers: AUTH });

      expect(res.statusCode).toBe(500);
      expect(mocks.logError).toHaveBeenCalled();
    });
  });
});
