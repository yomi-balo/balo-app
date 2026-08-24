import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAuthorizeMeetingReschedule,
  mockAcceptRescheduleProposal,
  mockDeclineRescheduleProposal,
  mockFindPendingForAnswer,
  mockIsWindowAvailableForExpert,
  mockCheckRateLimit,
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
    mockAcceptRescheduleProposal: vi.fn(),
    mockDeclineRescheduleProposal: vi.fn(),
    mockFindPendingForAnswer: vi.fn(),
    mockIsWindowAvailableForExpert: vi.fn(),
    mockCheckRateLimit: vi.fn(),
    mockFindLiveByMeetingId: vi.fn(),
    MeetingNotReschedulableErrorStub: MeetingNotReschedulableErrorImpl,
  };
});

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  MeetingNotReschedulableError: MeetingNotReschedulableErrorStub,
  meetingCalendarEventsRepository: { findLiveByMeetingId: mockFindLiveByMeetingId },
  rescheduleProposalsRepository: { findPendingForAnswer: mockFindPendingForAnswer },
}));
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
vi.mock('../../services/meetings/reschedule-proposals.js', () => ({
  acceptRescheduleProposal: mockAcceptRescheduleProposal,
  declineRescheduleProposal: mockDeclineRescheduleProposal,
}));
vi.mock('../../services/availability/window-availability.js', () => ({
  isWindowAvailableForExpert: mockIsWindowAvailableForExpert,
}));

import Fastify, {
  type FastifyInstance,
  type InjectOptions,
  type LightMyRequestResponse,
} from 'fastify';
import { meetingRescheduleProposalAnswerRoutes } from './reschedule-proposal-answers.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const MEETING_ID = '22222222-2222-4222-8222-222222222222';
const PROPOSAL_ID = '33333333-3333-4333-8333-333333333333';
const OPTION_ID = '77777777-7777-4777-8777-777777777777';
const EXPERT_PROFILE_ID = '66666666-6666-4666-8666-666666666666';
const AUDIT_ID = '88888888-8888-4888-8888-888888888888';
const AUTH = { authorization: 'Bearer test-token' };

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

function fromNow(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

const CURRENT_START = new Date(fromNow(DAY_MS));
const CURRENT_END = new Date(fromNow(DAY_MS + 30 * MINUTE_MS));
const OPTION_START = new Date(fromNow(2 * DAY_MS));
const OPTION_END = new Date(fromNow(2 * DAY_MS + 30 * MINUTE_MS));

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
    subject: { contextType: 'case', contextId: 'engagement-1' },
    companyId: 'company-1',
    expertProfileId: EXPERT_PROFILE_ID,
    ...overrides,
  };
}

function proposalRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PROPOSAL_ID,
    status: 'pending',
    expiresAt: new Date(fromNow(3 * DAY_MS)),
    originalScheduledStart: CURRENT_START,
    ...overrides,
  };
}

function foundOk(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    proposal: proposalRow(),
    options: [
      { id: OPTION_ID, scheduledStart: OPTION_START, scheduledEnd: OPTION_END, position: 0 },
    ],
    ...overrides,
  };
}

describe('POST /meetings/:meetingId/reschedule-proposals/:proposalId (BAL-411 answers)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    app.setErrorHandler((_error, _request, reply) => {
      reply.status(500).send({ error: 'Internal Server Error' });
    });
    await app.register(meetingRescheduleProposalAnswerRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 19, ttlSeconds: 3600 });
    mockAuthorizeMeetingReschedule.mockResolvedValue(authOk());
    mockFindPendingForAnswer.mockResolvedValue(foundOk());
    mockFindLiveByMeetingId.mockResolvedValue(undefined);
    mockIsWindowAvailableForExpert.mockResolvedValue(true);
    mockAcceptRescheduleProposal.mockResolvedValue({
      proposalId: PROPOSAL_ID,
      meetingId: MEETING_ID,
      scheduledStart: OPTION_START,
      scheduledEnd: OPTION_END,
      previousScheduledStart: CURRENT_START,
      previousScheduledEnd: CURRENT_END,
      rescheduleAuditId: AUDIT_ID,
    });
    mockDeclineRescheduleProposal.mockResolvedValue({ id: PROPOSAL_ID, status: 'declined' });
  });

  async function call(opts: InjectOptions): Promise<LightMyRequestResponse> {
    return app.inject(opts);
  }

  describe('accept', () => {
    const URL = `/meetings/${MEETING_ID}/reschedule-proposals/${PROPOSAL_ID}/accept`;

    it('401 without a Bearer', async () => {
      const res = await call({ method: 'POST', url: URL, payload: { optionId: OPTION_ID } });
      expect(res.statusCode).toBe(401);
      expect(mockAuthorizeMeetingReschedule).not.toHaveBeenCalled();
    });

    it('400 invalid_request on a malformed body', async () => {
      const res = await call({ method: 'POST', url: URL, headers: AUTH, payload: {} });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid_request' });
    });

    it('404 meeting_not_found on an authz denial', async () => {
      mockAuthorizeMeetingReschedule.mockResolvedValue({ ok: false, code: 'meeting_not_found' });
      const res = await call({
        method: 'POST',
        url: URL,
        headers: AUTH,
        payload: { optionId: OPTION_ID },
      });
      expect(res.statusCode).toBe(404);
      expect(mockFindPendingForAnswer).not.toHaveBeenCalled();
    });

    it('409 proposal_not_answerable when the proposal does not exist on this meeting', async () => {
      mockFindPendingForAnswer.mockResolvedValue(undefined);
      const res = await call({
        method: 'POST',
        url: URL,
        headers: AUTH,
        payload: { optionId: OPTION_ID },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'proposal_not_answerable' });
    });

    it('409 proposal_not_answerable when already resolved', async () => {
      mockFindPendingForAnswer.mockResolvedValue(
        foundOk({ proposal: proposalRow({ status: 'declined' }) })
      );
      const res = await call({
        method: 'POST',
        url: URL,
        headers: AUTH,
        payload: { optionId: OPTION_ID },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'proposal_not_answerable' });
    });

    it('409 proposal_not_answerable when expired', async () => {
      mockFindPendingForAnswer.mockResolvedValue(
        foundOk({ proposal: proposalRow({ expiresAt: new Date(fromNow(-MINUTE_MS)) }) })
      );
      const res = await call({
        method: 'POST',
        url: URL,
        headers: AUTH,
        payload: { optionId: OPTION_ID },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'proposal_not_answerable' });
    });

    it('409 proposal_stale when the meeting moved underneath it', async () => {
      mockFindPendingForAnswer.mockResolvedValue(
        foundOk({
          proposal: proposalRow({ originalScheduledStart: new Date(fromNow(5 * DAY_MS)) }),
        })
      );
      const res = await call({
        method: 'POST',
        url: URL,
        headers: AUTH,
        payload: { optionId: OPTION_ID },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'proposal_stale' });
    });

    it('409 proposal_not_answerable for an option that does not belong to this proposal', async () => {
      const res = await call({
        method: 'POST',
        url: URL,
        headers: AUTH,
        payload: { optionId: '99999999-9999-4999-8999-999999999999' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'proposal_not_answerable' });
    });

    it.each(['waiting_for_participants', 'in_progress', 'ended', 'cancelled'])(
      '409 meeting_not_reschedulable for status=%s',
      async (status) => {
        mockAuthorizeMeetingReschedule.mockResolvedValue(
          authOk({ meeting: meetingRow({ status }) })
        );
        const res = await call({
          method: 'POST',
          url: URL,
          headers: AUTH,
          payload: { optionId: OPTION_ID },
        });
        expect(res.statusCode).toBe(409);
        expect(res.json()).toEqual({ error: 'meeting_not_reschedulable' });
      }
    );

    it('409 window_not_available when the re-validated option collides', async () => {
      mockIsWindowAvailableForExpert.mockResolvedValue(false);
      const res = await call({
        method: 'POST',
        url: URL,
        headers: AUTH,
        payload: { optionId: OPTION_ID },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'window_not_available' });
      expect(mockAcceptRescheduleProposal).not.toHaveBeenCalled();
    });

    it('re-pins scheduledEnd from the meeting live duration, not the stored option.scheduledEnd', async () => {
      // The meeting's current duration is 30min; the option's own display end implies the same,
      // but the service call must receive a duration computed from the LIVE meeting, not a
      // trusted copy of the option row.
      await call({ method: 'POST', url: URL, headers: AUTH, payload: { optionId: OPTION_ID } });
      const [input] = mockAcceptRescheduleProposal.mock.calls[0] as [
        { scheduledStart: Date; scheduledEnd: Date },
      ];
      const impliedDurationMs = input.scheduledEnd.getTime() - input.scheduledStart.getTime();
      expect(impliedDurationMs).toBe(CURRENT_END.getTime() - CURRENT_START.getTime());
    });

    it('threads excludeMeeting into isWindowAvailableForExpert', async () => {
      mockFindLiveByMeetingId.mockResolvedValue({ id: 'cal-event-1' });
      await call({ method: 'POST', url: URL, headers: AUTH, payload: { optionId: OPTION_ID } });
      expect(mockIsWindowAvailableForExpert).toHaveBeenCalledWith(
        EXPERT_PROFILE_ID,
        OPTION_START,
        expect.any(Date),
        expect.any(Date),
        expect.objectContaining({
          meetingId: MEETING_ID,
          currentStart: CURRENT_START,
          currentEnd: CURRENT_END,
          hasVendorEvent: true,
        })
      );
    });

    it('409 proposal_not_answerable when the service loses the CAS race', async () => {
      mockAcceptRescheduleProposal.mockResolvedValue(undefined);
      const res = await call({
        method: 'POST',
        url: URL,
        headers: AUTH,
        payload: { optionId: OPTION_ID },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'proposal_not_answerable' });
    });

    it('409 meeting_not_reschedulable on a TOCTOU race — NO uuid reaches the wire', async () => {
      mockAcceptRescheduleProposal.mockRejectedValue(
        new MeetingNotReschedulableErrorStub(MEETING_ID)
      );
      const res = await call({
        method: 'POST',
        url: URL,
        headers: AUTH,
        payload: { optionId: OPTION_ID },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'meeting_not_reschedulable' });
      expect(res.body).not.toContain(MEETING_ID);
    });

    it('500 never echoes an internal message on an unexpected throw', async () => {
      mockAcceptRescheduleProposal.mockRejectedValue(
        new Error('engagement 44444444 is not resolvable')
      );
      const res = await call({
        method: 'POST',
        url: URL,
        headers: AUTH,
        payload: { optionId: OPTION_ID },
      });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: 'Internal Server Error' });
    });

    it('200 happy path, returning the COMMITTED window and the audit id', async () => {
      const res = await call({
        method: 'POST',
        url: URL,
        headers: AUTH,
        payload: { optionId: OPTION_ID },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        proposalId: PROPOSAL_ID,
        meetingId: MEETING_ID,
        scheduledStart: OPTION_START.toISOString(),
        scheduledEnd: OPTION_END.toISOString(),
        previousScheduledStart: CURRENT_START.toISOString(),
        previousScheduledEnd: CURRENT_END.toISOString(),
        rescheduleAuditId: AUDIT_ID,
      });
    });

    it('429 with Retry-After once the per-user window is spent', async () => {
      mockCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0, ttlSeconds: 900 });
      const res = await call({
        method: 'POST',
        url: URL,
        headers: AUTH,
        payload: { optionId: OPTION_ID },
      });
      expect(res.statusCode).toBe(429);
    });
  });

  describe('decline', () => {
    const URL = `/meetings/${MEETING_ID}/reschedule-proposals/${PROPOSAL_ID}/decline`;

    it('404 meeting_not_found on an authz denial', async () => {
      mockAuthorizeMeetingReschedule.mockResolvedValue({ ok: false, code: 'meeting_not_found' });
      const res = await call({ method: 'POST', url: URL, headers: AUTH });
      expect(res.statusCode).toBe(404);
      expect(mockDeclineRescheduleProposal).not.toHaveBeenCalled();
    });

    it('409 proposal_not_answerable when the service returns undefined', async () => {
      mockDeclineRescheduleProposal.mockResolvedValue(undefined);
      const res = await call({ method: 'POST', url: URL, headers: AUTH });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'proposal_not_answerable' });
    });

    it('200 happy path', async () => {
      const res = await call({ method: 'POST', url: URL, headers: AUTH });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ proposalId: PROPOSAL_ID, status: 'declined' });
      expect(mockDeclineRescheduleProposal).toHaveBeenCalledWith(
        expect.objectContaining({
          proposalId: PROPOSAL_ID,
          meetingId: MEETING_ID,
          actorUserId: USER_ID,
        }),
        expect.anything()
      );
    });
  });
});
