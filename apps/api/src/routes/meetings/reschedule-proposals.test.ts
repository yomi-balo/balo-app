import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAuthorizeMeetingRescheduleProposal,
  mockProposeReschedule,
  mockWithdrawRescheduleProposal,
  mockIsWindowAvailableForExpert,
  mockCheckRateLimit,
  mockFindByEngagementId,
  mockFindLiveByMeetingId,
  mockFindProfileById,
  mockFindUserById,
  mockGetSummaryById,
  RescheduleProposalAlreadyPendingErrorStub,
} = vi.hoisted(() => {
  class RescheduleProposalAlreadyPendingErrorImpl extends Error {
    constructor(meetingId: string) {
      super(`A pending reschedule proposal already exists for meeting: ${meetingId}`);
      this.name = 'RescheduleProposalAlreadyPendingError';
    }
  }
  return {
    mockAuthorizeMeetingRescheduleProposal: vi.fn(),
    mockProposeReschedule: vi.fn(),
    mockWithdrawRescheduleProposal: vi.fn(),
    mockIsWindowAvailableForExpert: vi.fn(),
    mockCheckRateLimit: vi.fn(),
    mockFindByEngagementId: vi.fn(),
    mockFindLiveByMeetingId: vi.fn(),
    mockFindProfileById: vi.fn(),
    mockFindUserById: vi.fn(),
    mockGetSummaryById: vi.fn(),
    RescheduleProposalAlreadyPendingErrorStub: RescheduleProposalAlreadyPendingErrorImpl,
  };
});

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  RescheduleProposalAlreadyPendingError: RescheduleProposalAlreadyPendingErrorStub,
  caseEngagementsRepository: { findByEngagementId: mockFindByEngagementId },
  meetingCalendarEventsRepository: { findLiveByMeetingId: mockFindLiveByMeetingId },
  // Fix round 1 item 16 — the route now reads the PROJECTED finders, not the full-row ones.
  expertsRepository: { findDisplayProfileById: mockFindProfileById },
  usersRepository: { findDisplayById: mockFindUserById },
  agenciesRepository: { getSummaryById: mockGetSummaryById },
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
vi.mock('../../services/meetings/authorize-meeting-reschedule-proposal.js', () => ({
  authorizeMeetingRescheduleProposal: mockAuthorizeMeetingRescheduleProposal,
}));
vi.mock('../../services/meetings/reschedule-proposals.js', () => ({
  proposeReschedule: mockProposeReschedule,
  withdrawRescheduleProposal: mockWithdrawRescheduleProposal,
}));
vi.mock('../../services/availability/window-availability.js', () => ({
  isWindowAvailableForExpert: mockIsWindowAvailableForExpert,
}));

import Fastify, {
  type FastifyInstance,
  type InjectOptions,
  type LightMyRequestResponse,
} from 'fastify';
import { meetingRescheduleProposalRoutes } from './reschedule-proposals.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const MEETING_ID = '22222222-2222-4222-8222-222222222222';
const PROPOSAL_ID = '33333333-3333-4333-8333-333333333333';
const ENGAGEMENT_ID = '44444444-4444-4444-8444-444444444444';
const COMPANY_ID = '55555555-5555-4555-8555-555555555555';
const EXPERT_PROFILE_ID = '66666666-6666-4666-8666-666666666666';
const AUTH = { authorization: 'Bearer test-token' };

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

function fromNow(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

const CURRENT_START = new Date(fromNow(DAY_MS));
const CURRENT_END = new Date(fromNow(DAY_MS + 30 * MINUTE_MS));

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
    engagementId: ENGAGEMENT_ID,
    companyId: COMPANY_ID,
    expertProfileId: EXPERT_PROFILE_ID,
    ...overrides,
  };
}

describe('POST /meetings/:meetingId/reschedule-proposals (BAL-411)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    app.setErrorHandler((_error, _request, reply) => {
      reply.status(500).send({ error: 'Internal Server Error' });
    });
    await app.register(meetingRescheduleProposalRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 9, ttlSeconds: 3600 });
    mockAuthorizeMeetingRescheduleProposal.mockResolvedValue(authOk());
    mockFindByEngagementId.mockResolvedValue({ title: 'Salesforce cleanup', closedAt: null });
    mockFindLiveByMeetingId.mockResolvedValue(undefined);
    mockFindProfileById.mockResolvedValue({
      userId: 'expert-user-1',
      agencyId: null,
      type: 'freelancer',
    });
    mockFindUserById.mockResolvedValue({ firstName: 'Dana', lastName: 'Lee' });
    mockGetSummaryById.mockResolvedValue(undefined);
    mockIsWindowAvailableForExpert.mockResolvedValue(true);
    mockProposeReschedule.mockResolvedValue({
      proposal: { id: PROPOSAL_ID, expiresAt: new Date(fromNow(2 * DAY_MS)) },
      options: [
        {
          id: 'option-1',
          scheduledStart: new Date(fromNow(2 * DAY_MS)),
          scheduledEnd: new Date(fromNow(2 * DAY_MS + 30 * MINUTE_MS)),
          position: 0,
        },
      ],
    });
    mockWithdrawRescheduleProposal.mockResolvedValue({ id: PROPOSAL_ID, status: 'withdrawn' });
  });

  async function call(opts: InjectOptions): Promise<LightMyRequestResponse> {
    return app.inject(opts);
  }

  function proposeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { options: [{ scheduledStart: fromNow(2 * DAY_MS) }], ...overrides };
  }

  describe('propose', () => {
    const URL = `/meetings/${MEETING_ID}/reschedule-proposals`;

    it('401 without a Bearer — the gate is never reached', async () => {
      const res = await call({ method: 'POST', url: URL, payload: proposeBody() });
      expect(res.statusCode).toBe(401);
      expect(mockAuthorizeMeetingRescheduleProposal).not.toHaveBeenCalled();
    });

    it('400 invalid_request on a malformed body', async () => {
      const res = await call({ method: 'POST', url: URL, headers: AUTH, payload: { options: [] } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid_request' });
      expect(mockAuthorizeMeetingRescheduleProposal).not.toHaveBeenCalled();
    });

    it('400 invalid_request on more than 3 options', async () => {
      const res = await call({
        method: 'POST',
        url: URL,
        headers: AUTH,
        payload: proposeBody({
          options: [
            { scheduledStart: fromNow(2 * DAY_MS) },
            { scheduledStart: fromNow(3 * DAY_MS) },
            { scheduledStart: fromNow(4 * DAY_MS) },
            { scheduledStart: fromNow(5 * DAY_MS) },
          ],
        }),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid_request' });
    });

    it('404 meeting_not_found on an authz denial', async () => {
      mockAuthorizeMeetingRescheduleProposal.mockResolvedValue({
        ok: false,
        code: 'meeting_not_found',
      });
      const res = await call({ method: 'POST', url: URL, headers: AUTH, payload: proposeBody() });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'meeting_not_found' });
      expect(mockProposeReschedule).not.toHaveBeenCalled();
    });

    it('409 case_closed when the case is closed', async () => {
      mockFindByEngagementId.mockResolvedValue({ title: 'x', closedAt: new Date() });
      const res = await call({ method: 'POST', url: URL, headers: AUTH, payload: proposeBody() });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'case_closed' });
      expect(mockProposeReschedule).not.toHaveBeenCalled();
    });

    it('409 case_closed when the case row is missing entirely', async () => {
      mockFindByEngagementId.mockResolvedValue(undefined);
      const res = await call({ method: 'POST', url: URL, headers: AUTH, payload: proposeBody() });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'case_closed' });
    });

    it.each(['waiting_for_participants', 'in_progress', 'ended', 'cancelled'])(
      '409 meeting_not_reschedulable for status=%s',
      async (status) => {
        mockAuthorizeMeetingRescheduleProposal.mockResolvedValue(
          authOk({ meeting: meetingRow({ status }) })
        );
        const res = await call({ method: 'POST', url: URL, headers: AUTH, payload: proposeBody() });
        expect(res.statusCode).toBe(409);
        expect(res.json()).toEqual({ error: 'meeting_not_reschedulable' });
      }
    );

    it('400 start_must_be_future for a past option', async () => {
      const res = await call({
        method: 'POST',
        url: URL,
        headers: AUTH,
        payload: proposeBody({ options: [{ scheduledStart: fromNow(-DAY_MS) }] }),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'start_must_be_future' });
    });

    it('400 duplicate_option for two identical starts', async () => {
      const start = fromNow(2 * DAY_MS);
      const res = await call({
        method: 'POST',
        url: URL,
        headers: AUTH,
        payload: proposeBody({ options: [{ scheduledStart: start }, { scheduledStart: start }] }),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'duplicate_option' });
      expect(mockIsWindowAvailableForExpert).not.toHaveBeenCalled();
    });

    it('409 window_not_available when an option collides', async () => {
      mockIsWindowAvailableForExpert.mockResolvedValue(false);
      const res = await call({ method: 'POST', url: URL, headers: AUTH, payload: proposeBody() });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'window_not_available' });
      expect(mockProposeReschedule).not.toHaveBeenCalled();
    });

    it('threads excludeMeeting into isWindowAvailableForExpert, per option', async () => {
      mockFindLiveByMeetingId.mockResolvedValue({ id: 'cal-event-1' });
      await call({ method: 'POST', url: URL, headers: AUTH, payload: proposeBody() });
      expect(mockIsWindowAvailableForExpert).toHaveBeenCalledWith(
        EXPERT_PROFILE_ID,
        expect.any(Date),
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

    it('409 proposal_already_pending when the service throws the typed error', async () => {
      mockProposeReschedule.mockRejectedValue(
        new RescheduleProposalAlreadyPendingErrorStub(MEETING_ID)
      );
      const res = await call({ method: 'POST', url: URL, headers: AUTH, payload: proposeBody() });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'proposal_already_pending' });
    });

    it('never echoes the typed error message (embeds a raw meetingId)', async () => {
      mockProposeReschedule.mockRejectedValue(
        new RescheduleProposalAlreadyPendingErrorStub(MEETING_ID)
      );
      const res = await call({ method: 'POST', url: URL, headers: AUTH, payload: proposeBody() });
      expect(res.body).not.toContain(MEETING_ID);
    });

    it('429 with Retry-After once the per-user window is spent', async () => {
      mockCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0, ttlSeconds: 900 });
      const res = await call({ method: 'POST', url: URL, headers: AUTH, payload: proposeBody() });
      expect(res.statusCode).toBe(429);
      expect(res.headers['retry-after']).toBe('900');
      expect(mockAuthorizeMeetingRescheduleProposal).not.toHaveBeenCalled();
    });

    it('503 rate_limit_unavailable — fails CLOSED', async () => {
      mockCheckRateLimit.mockRejectedValue(new Error('redis unreachable'));
      const res = await call({ method: 'POST', url: URL, headers: AUTH, payload: proposeBody() });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'rate_limit_unavailable' });
    });

    it('200 happy path', async () => {
      const res = await call({ method: 'POST', url: URL, headers: AUTH, payload: proposeBody() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        proposalId: PROPOSAL_ID,
        meetingId: MEETING_ID,
        options: [expect.objectContaining({ optionId: 'option-1', position: 0 })],
      });
      expect(mockProposeReschedule).toHaveBeenCalledWith(
        expect.objectContaining({
          meetingId: MEETING_ID,
          engagementId: ENGAGEMENT_ID,
          companyId: COMPANY_ID,
          proposedByUserId: USER_ID,
          caseTitle: 'Salesforce cleanup',
        }),
        expect.anything()
      );
    });

    it('resolves an agency-based expert label from the profile chain', async () => {
      mockFindProfileById.mockResolvedValue({
        userId: 'expert-user-1',
        agencyId: 'agency-1',
        type: 'agency',
      });
      mockGetSummaryById.mockResolvedValue({ name: 'CloudPeak' });
      await call({ method: 'POST', url: URL, headers: AUTH, payload: proposeBody() });
      expect(mockProposeReschedule).toHaveBeenCalledWith(
        expect.objectContaining({ expertPartyLabel: expect.stringContaining('CloudPeak') }),
        expect.anything()
      );
    });
  });

  describe('withdraw', () => {
    const URL = `/meetings/${MEETING_ID}/reschedule-proposals/${PROPOSAL_ID}/withdraw`;

    it('401 without a Bearer', async () => {
      const res = await call({ method: 'POST', url: URL });
      expect(res.statusCode).toBe(401);
    });

    it('404 meeting_not_found on an authz denial', async () => {
      mockAuthorizeMeetingRescheduleProposal.mockResolvedValue({
        ok: false,
        code: 'meeting_not_found',
      });
      const res = await call({ method: 'POST', url: URL, headers: AUTH });
      expect(res.statusCode).toBe(404);
      expect(mockWithdrawRescheduleProposal).not.toHaveBeenCalled();
    });

    it('409 proposal_not_answerable when the service returns undefined (lost CAS)', async () => {
      mockWithdrawRescheduleProposal.mockResolvedValue(undefined);
      const res = await call({ method: 'POST', url: URL, headers: AUTH });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'proposal_not_answerable' });
    });

    it('does NOT check case liveness — withdraw is not gated on it', async () => {
      mockFindByEngagementId.mockResolvedValue({ title: 'x', closedAt: new Date() });
      const res = await call({ method: 'POST', url: URL, headers: AUTH });
      expect(res.statusCode).toBe(200);
      expect(mockFindByEngagementId).not.toHaveBeenCalled();
    });

    it('200 happy path', async () => {
      const res = await call({ method: 'POST', url: URL, headers: AUTH });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ proposalId: PROPOSAL_ID, status: 'withdrawn' });
      expect(mockWithdrawRescheduleProposal).toHaveBeenCalledWith(
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
