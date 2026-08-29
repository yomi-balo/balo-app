import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAuthorizeMeetingCancel,
  mockCancelMeeting,
  mockPublishBookingCancelled,
  mockCheckRateLimit,
  MeetingNotCancellableErrorStub,
} = vi.hoisted(() => {
  class MeetingNotCancellableErrorImpl extends Error {
    readonly meetingId: string;
    constructor(meetingId: string) {
      super(`Meeting ${meetingId} is not cancellable (must be live and status='scheduled')`);
      this.name = 'MeetingNotCancellableError';
      this.meetingId = meetingId;
    }
  }
  return {
    mockAuthorizeMeetingCancel: vi.fn(),
    mockCancelMeeting: vi.fn(),
    mockPublishBookingCancelled: vi.fn(),
    mockCheckRateLimit: vi.fn(),
    MeetingNotCancellableErrorStub: MeetingNotCancellableErrorImpl,
  };
});

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  MeetingNotCancellableError: MeetingNotCancellableErrorStub,
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
vi.mock('../../services/meetings/authorize-meeting-cancel.js', () => ({
  authorizeMeetingCancel: mockAuthorizeMeetingCancel,
}));
vi.mock('../../services/meetings/meeting-availability.js', () => ({
  cancelMeeting: mockCancelMeeting,
}));
vi.mock('../../services/meetings/publish-booking-cancelled.js', () => ({
  publishBookingCancelled: mockPublishBookingCancelled,
}));
// ⚠ `./join.schema.js`, `./cancel.schema.js` AND `@balo/shared/meetings` are DELIBERATELY NOT
// MOCKED — the real Zod boundary is what the `400` rows assert, and the real
// `resolveCancelRefusal` allow-list is what the `409` rows assert.

import Fastify, {
  type FastifyInstance,
  type InjectOptions,
  type LightMyRequestResponse,
} from 'fastify';
import { meetingCancelRoutes } from './cancel.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const MEETING_ID = '22222222-2222-4222-8222-222222222222';
const ENGAGEMENT_ID = '33333333-3333-4333-8333-333333333333';
const EXPERT_PROFILE_ID = '66666666-6666-4666-8666-666666666666';
/** The `meeting.cancelled` audit row id — the outbound fan-out's per-WRITE dedup key. */
const AUDIT_ID = '77777777-7777-4777-8777-777777777777';
const URL = `/meetings/${MEETING_ID}/cancel`;
const AUTH = { authorization: 'Bearer test-token' };

const SCHEDULED_START = new Date('2026-09-01T10:00:00.000Z');
const SCHEDULED_END = new Date('2026-09-01T10:30:00.000Z');

function meetingRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: MEETING_ID,
    status: 'scheduled',
    dailyRoomName: null,
    scheduledStart: SCHEDULED_START,
    scheduledEnd: SCHEDULED_END,
    ...overrides,
  };
}

function authOk(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    meeting: meetingRow(),
    subject: { contextType: 'case', contextId: ENGAGEMENT_ID },
    actorRole: 'client',
    companyId: 'company-1',
    expertProfileId: EXPERT_PROFILE_ID,
    ...overrides,
  };
}

function cancelOk(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    meeting: meetingRow(),
    expertProfileId: EXPERT_PROFILE_ID,
    cancelAuditId: AUDIT_ID,
    holdReleased: false,
    ...overrides,
  };
}

describe('POST /meetings/:meetingId/cancel (BAL-410)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    app.setErrorHandler((_error, _request, reply) => {
      reply.status(500).send({ error: 'Internal Server Error' });
    });
    await app.register(meetingCancelRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({ allowed: true, ttlSeconds: 0 });
    mockAuthorizeMeetingCancel.mockResolvedValue(authOk());
    mockCancelMeeting.mockResolvedValue(cancelOk());
    mockPublishBookingCancelled.mockResolvedValue(undefined);
  });

  function post(options: Partial<InjectOptions> = {}): Promise<LightMyRequestResponse> {
    return app.inject({
      method: 'POST',
      url: URL,
      headers: AUTH,
      payload: {},
      ...options,
    });
  }

  // ── AUTH ──────────────────────────────────────────────────────────────────

  it('401 without a bearer token', async () => {
    const response = await post({ headers: {} });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Unauthorized' });
    expect(mockAuthorizeMeetingCancel).not.toHaveBeenCalled();
  });

  // ── RATE LIMIT — its OWN bucket, and it fails CLOSED ──────────────────────

  it('429 when the per-user cancel limit is exhausted', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, ttlSeconds: 42 });

    const response = await post();

    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ error: 'rate_limited' });
    expect(response.headers['retry-after']).toBe('42');
  });

  it('⚠ 503 — the limiter fails CLOSED on a Redis outage, never "carry on unlimited"', async () => {
    mockCheckRateLimit.mockRejectedValue(new Error('ECONNREFUSED'));

    const response = await post();

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'rate_limit_unavailable' });
    expect(mockCancelMeeting).not.toHaveBeenCalled();
  });

  it('consumes its OWN bucket, not the reschedule one', async () => {
    await post();

    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ keyPrefix: 'ratelimit:meetings:cancel:user' }),
      USER_ID
    );
  });

  // ── VALIDATION ────────────────────────────────────────────────────────────

  it('400 on a non-uuid meetingId, with NO details echo (a param id would be a uuid on the wire)', async () => {
    const response = await post({ url: '/meetings/not-a-uuid/cancel' });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_request' });
  });

  it('⚠ 400 on a body carrying `reason` — an absent expectation is not an absent acceptance', async () => {
    // The G1 lesson. A wire-accepted `reason` would let a client trigger the "your expert has
    // taken time off" copy on a cancellation the expert had nothing to do with. `.strict()`
    // REJECTS rather than silently stripping.
    const response = await post({ payload: { reason: 'expert_time_off' } });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_request' });
    expect(mockCancelMeeting).not.toHaveBeenCalled();
  });

  it.each([
    ['initiatedBy', { initiatedBy: 'admin' }],
    ['cancelledBy', { cancelledBy: 'admin' }],
    ['an arbitrary extra field', { anything: 1 }],
  ])('400 on a body carrying %s (.strict())', async (_label, payload) => {
    const response = await post({ payload });

    expect(response.statusCode).toBe(400);
    expect(mockCancelMeeting).not.toHaveBeenCalled();
  });

  it('accepts an EMPTY body — the schema is deliberately empty', async () => {
    const response = await post({ payload: {} });

    expect(response.statusCode).toBe(200);
  });

  // ── MEMBERSHIP BEFORE STATE ───────────────────────────────────────────────

  it('404 meeting_not_found when the gate denies', async () => {
    mockAuthorizeMeetingCancel.mockResolvedValue({ ok: false, code: 'meeting_not_found' });

    const response = await post();

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'meeting_not_found' });
    expect(mockCancelMeeting).not.toHaveBeenCalled();
  });

  it('⚠ runs the GATE before any state check — a denied caller learns nothing about status', async () => {
    // Both a cancelled meeting and a non-member answer differently ONLY if state is checked
    // first. Here the gate denies and the response is 404, not 409 — no existence oracle.
    mockAuthorizeMeetingCancel.mockResolvedValue({ ok: false, code: 'meeting_not_found' });

    const response = await post();

    expect(response.statusCode).toBe(404);
  });

  // ── STATE ─────────────────────────────────────────────────────────────────

  it.each(['waiting_for_participants', 'in_progress', 'ended', 'cancelled'])(
    '409 meeting_not_cancellable for a %s meeting',
    async (status) => {
      mockAuthorizeMeetingCancel.mockResolvedValue(authOk({ meeting: meetingRow({ status }) }));

      const response = await post();

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: 'meeting_not_cancellable' });
      expect(mockCancelMeeting).not.toHaveBeenCalled();
    }
  );

  it('⚠ a PAST-START, never-joined `scheduled` meeting is still cancellable (D5 — no clock)', async () => {
    mockAuthorizeMeetingCancel.mockResolvedValue(
      authOk({
        meeting: meetingRow({
          status: 'scheduled',
          scheduledStart: new Date('2020-01-01T10:00:00.000Z'),
          scheduledEnd: new Date('2020-01-01T10:30:00.000Z'),
        }),
      })
    );

    const response = await post();

    expect(response.statusCode).toBe(200);
  });

  // ── SUCCESS ───────────────────────────────────────────────────────────────

  it('200 with the released window, the audit id, the arm and holdReleased', async () => {
    mockCancelMeeting.mockResolvedValue(cancelOk({ holdReleased: true }));

    const response = await post();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      meetingId: MEETING_ID,
      status: 'cancelled',
      scheduledStart: SCHEDULED_START.toISOString(),
      cancelAuditId: AUDIT_ID,
      initiatedBy: 'client',
      holdReleased: true,
    });
  });

  it('⚠ `initiatedBy` is the GATE’s arm, never anything from the request', async () => {
    mockAuthorizeMeetingCancel.mockResolvedValue(authOk({ actorRole: 'admin' }));

    const response = await post({ payload: {} });

    expect(response.json()).toMatchObject({ initiatedBy: 'admin' });
  });

  /**
   * ⚠⚠ `holdReleased` IS THE CLIENT ARM'S ALONE (security LOW-1). The hold is the CLIENT's
   * money, and the in-app expert template already withholds hold language on exactly that
   * ground. Returning it on the expert or admin arm would tell the delivering expert (and their
   * agency owner/admin, and Balo staff) that the client had been admitted early with a funded
   * wallet. THE KEY IS ABSENT, not `false` — `false` would be a claim, and an untrue one
   * whenever a hold really was released.
   */
  it.each(['expert', 'admin'] as const)(
    '⚠ OMITS holdReleased entirely on the %s arm — absent, never false',
    async (actorRole) => {
      mockAuthorizeMeetingCancel.mockResolvedValue(authOk({ actorRole }));
      mockCancelMeeting.mockResolvedValue(cancelOk({ holdReleased: true }));

      const response = await post();

      const body = response.json<Record<string, unknown>>();
      expect(response.statusCode).toBe(200);
      expect(body).not.toHaveProperty('holdReleased');
      expect(body).toMatchObject({ initiatedBy: actorRole });
    }
  );

  /** ⚠ The publish and the SERVER LOG still carry it on every arm — only the WIRE is narrowed. */
  it('still publishes holdReleased on an expert-initiated cancel', async () => {
    mockAuthorizeMeetingCancel.mockResolvedValue(authOk({ actorRole: 'expert' }));
    mockCancelMeeting.mockResolvedValue(cancelOk({ holdReleased: true }));

    await post();

    expect(mockPublishBookingCancelled).toHaveBeenCalledWith(
      expect.objectContaining({ cancelledBy: 'expert', holdReleased: true }),
      expect.anything()
    );
  });

  it('threads the acting user AND the matched arm into the service', async () => {
    mockAuthorizeMeetingCancel.mockResolvedValue(authOk({ actorRole: 'expert' }));

    await post();

    expect(mockCancelMeeting).toHaveBeenCalledWith(
      MEETING_ID,
      USER_ID,
      'expert',
      expect.anything()
    );
  });

  // ── TOCTOU ────────────────────────────────────────────────────────────────

  it('409 on MeetingNotCancellableError, with NO message echo', async () => {
    mockCancelMeeting.mockRejectedValue(new MeetingNotCancellableErrorStub(MEETING_ID));

    const response = await post();

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'meeting_not_cancellable' });
    // ⚠ `.message` embeds a raw meetingId. It must never reach the client.
    expect(response.body).not.toContain(MEETING_ID);
  });

  it('500 on any other error — never a silently-mapped one', async () => {
    mockCancelMeeting.mockRejectedValue(new Error('connection terminated'));

    const response = await post();

    expect(response.statusCode).toBe(500);
  });

  // ── THE PUBLISH ───────────────────────────────────────────────────────────

  it('publishes booking.cancelled with the gate’s subject and the audit id', async () => {
    mockCancelMeeting.mockResolvedValue(cancelOk({ holdReleased: true }));

    await post();

    expect(mockPublishBookingCancelled).toHaveBeenCalledWith(
      expect.objectContaining({
        meetingId: MEETING_ID,
        subject: { contextType: 'case', contextId: ENGAGEMENT_ID },
        actorUserId: USER_ID,
        cancelledBy: 'client',
        cancelAuditId: AUDIT_ID,
        holdReleased: true,
      }),
      expect.anything()
    );
  });

  it('⚠ a THROWING publish does not change the status code — the cancel already committed', async () => {
    mockPublishBookingCancelled.mockRejectedValue(new Error('redis down'));

    const response = await post();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ meetingId: MEETING_ID });
  });

  it('does NOT publish when the cancel itself failed', async () => {
    mockCancelMeeting.mockRejectedValue(new MeetingNotCancellableErrorStub(MEETING_ID));

    await post();

    expect(mockPublishBookingCancelled).not.toHaveBeenCalled();
  });
});
