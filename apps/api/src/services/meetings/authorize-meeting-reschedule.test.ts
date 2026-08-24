import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockMeetingFindById,
  mockListByMeeting,
  mockEngagementFindById,
  mockProjectRequestFindById,
  mockRelationshipFindById,
  mockGetMemberRole,
} = vi.hoisted(() => ({
  mockMeetingFindById: vi.fn(),
  mockListByMeeting: vi.fn(),
  mockEngagementFindById: vi.fn(),
  mockProjectRequestFindById: vi.fn(),
  mockRelationshipFindById: vi.fn(),
  mockGetMemberRole: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  meetingsRepository: { findById: mockMeetingFindById },
  meetingContextsRepository: { listByMeeting: mockListByMeeting },
  engagementsRepository: { findById: mockEngagementFindById },
  projectRequestsRepository: { findById: mockProjectRequestFindById },
  requestExpertRelationshipsRepository: { findById: mockRelationshipFindById },
  partyMembershipsRepository: { getMemberRole: mockGetMemberRole },
}));
// ⚠ `@balo/shared/authz` and `@balo/shared/meetings` are deliberately NOT mocked — the real
// `roleHasCapability` map and the real precedence rule ARE what is under test at their steps.

import { authorizeMeetingReschedule } from './authorize-meeting-reschedule.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const MEETING_ID = '22222222-2222-4222-8222-222222222222';
const COMPANY_ID = '33333333-3333-4333-8333-333333333333';
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
  mockEngagementFindById.mockResolvedValue({
    companyId: COMPANY_ID,
    expertProfileId: EXPERT_PROFILE_ID,
  });
  mockGetMemberRole.mockResolvedValue(undefined);
});

describe('authorizeMeetingReschedule — T-API-AUTHZ', () => {
  it('denies a missing meeting with meeting_not_found', async () => {
    mockMeetingFindById.mockResolvedValue(undefined);

    const result = await authorizeMeetingReschedule({ meetingId: MEETING_ID, userId: USER_ID });

    expect(result).toEqual({ ok: false, code: 'meeting_not_found' });
  });

  it('a soft-deleted meeting is indistinguishable from missing (findById filters deleted_at)', async () => {
    // `findById` itself filters soft-deleted rows — this asserts the gate does not re-derive
    // liveness a second way; it trusts `undefined` as ONE outcome.
    mockMeetingFindById.mockResolvedValue(undefined);

    const result = await authorizeMeetingReschedule({ meetingId: MEETING_ID, userId: USER_ID });

    expect(result).toEqual({ ok: false, code: 'meeting_not_found' });
  });

  it('denies when the meeting has no live context', async () => {
    mockListByMeeting.mockResolvedValue([]);

    const result = await authorizeMeetingReschedule({ meetingId: MEETING_ID, userId: USER_ID });

    expect(result).toEqual({ ok: false, code: 'meeting_not_found' });
  });

  it('denies on an ambiguous context set (same literal as no_context)', async () => {
    mockListByMeeting.mockResolvedValue([
      { contextType: 'case', contextId: ENGAGEMENT_ID },
      { contextType: 'project_kickoff', contextId: OTHER_ENGAGEMENT_ID },
    ]);

    const result = await authorizeMeetingReschedule({ meetingId: MEETING_ID, userId: USER_ID });

    expect(result).toEqual({ ok: false, code: 'meeting_not_found' });
  });

  it('denies when the context does not resolve to a live row', async () => {
    mockEngagementFindById.mockResolvedValue(undefined);

    const result = await authorizeMeetingReschedule({ meetingId: MEETING_ID, userId: USER_ID });

    expect(result).toEqual({ ok: false, code: 'meeting_not_found' });
  });

  it('denies a non-member of the owning company (cross-tenant)', async () => {
    mockGetMemberRole.mockResolvedValue(undefined);

    const result = await authorizeMeetingReschedule({ meetingId: MEETING_ID, userId: USER_ID });

    expect(result).toEqual({ ok: false, code: 'meeting_not_found' });
    expect(mockGetMemberRole).toHaveBeenCalledWith('company', COMPANY_ID, USER_ID);
  });

  it('denies a member whose role lacks PARTICIPATE', async () => {
    // No shipped company role actually lacks PARTICIPATE (it is the base bundle), but the
    // gate must still refuse a role string `roleHasCapability` does not recognise.
    mockGetMemberRole.mockResolvedValue('not-a-real-role');

    const result = await authorizeMeetingReschedule({ meetingId: MEETING_ID, userId: USER_ID });

    expect(result).toEqual({ ok: false, code: 'meeting_not_found' });
  });

  it('the happy path threads meeting/subject/companyId/expertProfileId back out', async () => {
    mockGetMemberRole.mockResolvedValue('member');

    const result = await authorizeMeetingReschedule({ meetingId: MEETING_ID, userId: USER_ID });

    expect(result).toMatchObject({
      ok: true,
      companyId: COMPANY_ID,
      expertProfileId: EXPERT_PROFILE_ID,
      subject: { contextType: 'case', contextId: ENGAGEMENT_ID },
    });
    expect((result as { meeting?: { id: string } }).meeting?.id).toBe(MEETING_ID);
  });

  it('membership is resolved on the COMPANY that owns the context, never on any other party', async () => {
    mockGetMemberRole.mockResolvedValue('owner');
    await authorizeMeetingReschedule({ meetingId: MEETING_ID, userId: USER_ID });
    expect(mockGetMemberRole).toHaveBeenCalledWith('company', COMPANY_ID, USER_ID);
  });

  it('a non-member on an in_progress meeting still gets meeting_not_found, never a state-based 409 (no oracle)', async () => {
    mockMeetingFindById.mockResolvedValue(meetingRow({ status: 'in_progress' }));
    mockGetMemberRole.mockResolvedValue(undefined);

    const result = await authorizeMeetingReschedule({ meetingId: MEETING_ID, userId: USER_ID });

    // The gate never even LOOKS at status — authorization runs before any state check.
    expect(result).toEqual({ ok: false, code: 'meeting_not_found' });
  });

  it('resolves expertProfileId: null for a match-routed project_discovery, without throwing', async () => {
    mockListByMeeting.mockResolvedValue([
      { contextType: 'project_discovery', contextId: OTHER_ENGAGEMENT_ID },
    ]);
    mockProjectRequestFindById.mockResolvedValue({
      companyId: COMPANY_ID,
      expertProfileId: null,
    });
    mockGetMemberRole.mockResolvedValue('member');

    const result = await authorizeMeetingReschedule({ meetingId: MEETING_ID, userId: USER_ID });

    expect(result).toMatchObject({ ok: true, companyId: COMPANY_ID, expertProfileId: null });
  });
});
