import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockMeetingFindById,
  mockListByMeeting,
  mockEngagementFindById,
  mockHasEngagementCapability,
} = vi.hoisted(() => ({
  mockMeetingFindById: vi.fn(),
  mockListByMeeting: vi.fn(),
  mockEngagementFindById: vi.fn(),
  mockHasEngagementCapability: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  meetingsRepository: { findById: mockMeetingFindById },
  meetingContextsRepository: { listByMeeting: mockListByMeeting },
  engagementsRepository: { findById: mockEngagementFindById },
}));
// `@balo/shared/meetings`'s `selectPrimaryMeetingContext` is deliberately NOT mocked — the
// real precedence rule is what the ambiguous-context test exercises.
vi.mock('./authorize-engagement-host.js', () => ({
  hasEngagementCapability: mockHasEngagementCapability,
}));

import { authorizeMeetingRescheduleProposal } from './authorize-meeting-reschedule-proposal.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const MEETING_ID = '22222222-2222-4222-8222-222222222222';
const ENGAGEMENT_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_ENGAGEMENT_ID = '55555555-5555-4555-8555-555555555555';
const EXPERT_PROFILE_ID = '88888888-8888-4888-8888-888888888888';

function meetingRow(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: MEETING_ID,
    status: 'scheduled',
    scheduledStart: new Date('2026-09-01T10:00:00.000Z'),
    scheduledEnd: new Date('2026-09-01T11:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMeetingFindById.mockResolvedValue(meetingRow());
  mockListByMeeting.mockResolvedValue([{ contextType: 'case', contextId: ENGAGEMENT_ID }]);
  mockHasEngagementCapability.mockResolvedValue(true);
  mockEngagementFindById.mockResolvedValue({ expertProfileId: EXPERT_PROFILE_ID });
});

describe('authorizeMeetingRescheduleProposal — T-API-AUTHZ-2', () => {
  it('denies a missing meeting with meeting_not_found', async () => {
    mockMeetingFindById.mockResolvedValue(undefined);

    const result = await authorizeMeetingRescheduleProposal({
      meetingId: MEETING_ID,
      userId: USER_ID,
    });

    expect(result).toEqual({ ok: false, code: 'meeting_not_found' });
    expect(mockHasEngagementCapability).not.toHaveBeenCalled();
  });

  it('denies when the meeting has no live context', async () => {
    mockListByMeeting.mockResolvedValue([]);

    const result = await authorizeMeetingRescheduleProposal({
      meetingId: MEETING_ID,
      userId: USER_ID,
    });

    expect(result).toEqual({ ok: false, code: 'meeting_not_found' });
  });

  it('denies on an ambiguous context set (same literal as no_context)', async () => {
    mockListByMeeting.mockResolvedValue([
      { contextType: 'case', contextId: ENGAGEMENT_ID },
      { contextType: 'project_kickoff', contextId: OTHER_ENGAGEMENT_ID },
    ]);

    const result = await authorizeMeetingRescheduleProposal({
      meetingId: MEETING_ID,
      userId: USER_ID,
    });

    expect(result).toEqual({ ok: false, code: 'meeting_not_found' });
  });

  it.each([
    'project_kickoff',
    'package_session',
    'retainer_checkin',
    'project_discovery',
    'request_interaction',
    'admin',
  ])('denies a non-case context type: %s (BAL-411 scope fence)', async (contextType) => {
    mockListByMeeting.mockResolvedValue([{ contextType, contextId: ENGAGEMENT_ID }]);

    const result = await authorizeMeetingRescheduleProposal({
      meetingId: MEETING_ID,
      userId: USER_ID,
    });

    expect(result).toEqual({ ok: false, code: 'meeting_not_found' });
    expect(mockHasEngagementCapability).not.toHaveBeenCalled();
  });

  it('denies an actor without manage_engagement on this case', async () => {
    mockHasEngagementCapability.mockResolvedValue(false);

    const result = await authorizeMeetingRescheduleProposal({
      meetingId: MEETING_ID,
      userId: USER_ID,
    });

    expect(result).toEqual({ ok: false, code: 'meeting_not_found' });
    expect(mockHasEngagementCapability).toHaveBeenCalledWith({ id: USER_ID }, 'manage_engagement', {
      contextType: 'case',
      contextId: ENGAGEMENT_ID,
    });
  });

  it('denies when the resolved engagement id is missing (integrity fallback)', async () => {
    mockEngagementFindById.mockResolvedValue(undefined);

    const result = await authorizeMeetingRescheduleProposal({
      meetingId: MEETING_ID,
      userId: USER_ID,
    });

    expect(result).toEqual({ ok: false, code: 'meeting_not_found' });
  });

  it('the happy path threads meeting/engagementId/expertProfileId back out', async () => {
    const result = await authorizeMeetingRescheduleProposal({
      meetingId: MEETING_ID,
      userId: USER_ID,
    });

    expect(result).toMatchObject({
      ok: true,
      engagementId: ENGAGEMENT_ID,
      expertProfileId: EXPERT_PROFILE_ID,
    });
    expect((result as { meeting?: { id: string } }).meeting?.id).toBe(MEETING_ID);
  });

  it('authorization runs before any state check — an ended meeting still gets a real verdict, no oracle', async () => {
    mockMeetingFindById.mockResolvedValue(meetingRow({ status: 'ended' }));
    mockHasEngagementCapability.mockResolvedValue(false);

    const result = await authorizeMeetingRescheduleProposal({
      meetingId: MEETING_ID,
      userId: USER_ID,
    });

    // The gate never even looks at status — same literal either way.
    expect(result).toEqual({ ok: false, code: 'meeting_not_found' });
  });
});
