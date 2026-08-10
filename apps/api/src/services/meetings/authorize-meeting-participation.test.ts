import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockMeetingFindById,
  mockListByMeeting,
  mockEngagementFindById,
  mockProjectRequestFindById,
  mockRelationshipFindById,
  mockGetMemberRole,
  mockHasEngagementCapability,
} = vi.hoisted(() => ({
  mockMeetingFindById: vi.fn(),
  mockListByMeeting: vi.fn(),
  mockEngagementFindById: vi.fn(),
  mockProjectRequestFindById: vi.fn(),
  mockRelationshipFindById: vi.fn(),
  mockGetMemberRole: vi.fn(),
  mockHasEngagementCapability: vi.fn(),
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
vi.mock('./authorize-engagement-host.js', () => ({
  hasEngagementCapability: mockHasEngagementCapability,
}));
// ⚠ `@balo/shared/authz` and `@balo/shared/meetings` are deliberately NOT mocked — the real
// `roleHasCapability` map and the real precedence rule ARE what is under test at their steps.

import { authorizeMeetingParticipation } from './authorize-meeting-participation.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const MEETING_ID = '22222222-2222-4222-8222-222222222222';
const COMPANY_ID = '33333333-3333-4333-8333-333333333333';
const ENGAGEMENT_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_ENGAGEMENT_ID = '55555555-5555-4555-8555-555555555555';
const REQUEST_ID = '66666666-6666-4666-8666-666666666666';
const RELATIONSHIP_ID = '77777777-7777-4777-8777-777777777777';
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
  mockHasEngagementCapability.mockResolvedValue(false);
});

describe('authorizeMeetingParticipation — the CLIENT side (membership axis)', () => {
  it('authorizes a live company member and resolves side=client', async () => {
    mockGetMemberRole.mockResolvedValue('member');

    const result = await authorizeMeetingParticipation({ meetingId: MEETING_ID, userId: USER_ID });

    expect(result).toMatchObject({
      ok: true,
      side: 'client',
      companyId: COMPANY_ID,
      expertProfileId: EXPERT_PROFILE_ID,
      subject: { contextType: 'case', contextId: ENGAGEMENT_ID },
    });
  });

  it('resolves membership on the COMPANY that owns the context, never on any other party', async () => {
    mockGetMemberRole.mockResolvedValue('owner');
    await authorizeMeetingParticipation({ meetingId: MEETING_ID, userId: USER_ID });
    expect(mockGetMemberRole).toHaveBeenCalledWith('company', COMPANY_ID, USER_ID);
  });

  it('⚠ never consults the ENGAGEMENT axis once company membership succeeds — the sides cannot both fire', async () => {
    mockGetMemberRole.mockResolvedValue('member');
    await authorizeMeetingParticipation({ meetingId: MEETING_ID, userId: USER_ID });
    expect(mockHasEngagementCapability).not.toHaveBeenCalled();
  });

  it('denies a live member whose role lacks PARTICIPATE (the real capability map decides)', async () => {
    mockGetMemberRole.mockResolvedValue('some_unknown_role');
    const result = await authorizeMeetingParticipation({ meetingId: MEETING_ID, userId: USER_ID });
    expect(result).toEqual({ ok: false, code: 'meeting_not_found' });
  });

  it('accepts every shipped company role, because PARTICIPATE is the base member bundle', async () => {
    for (const role of ['owner', 'admin', 'member']) {
      vi.clearAllMocks();
      mockMeetingFindById.mockResolvedValue(meetingRow());
      mockListByMeeting.mockResolvedValue([{ contextType: 'case', contextId: ENGAGEMENT_ID }]);
      mockEngagementFindById.mockResolvedValue({
        companyId: COMPANY_ID,
        expertProfileId: EXPERT_PROFILE_ID,
      });
      mockGetMemberRole.mockResolvedValue(role);

      const result = await authorizeMeetingParticipation({
        meetingId: MEETING_ID,
        userId: USER_ID,
      });
      expect(result).toMatchObject({ ok: true, side: 'client' });
    }
  });
});

describe('authorizeMeetingParticipation — the EXPERT side (engagement axis)', () => {
  it('authorizes a manage_engagement holder and resolves side=expert', async () => {
    mockHasEngagementCapability.mockResolvedValue(true);

    const result = await authorizeMeetingParticipation({ meetingId: MEETING_ID, userId: USER_ID });

    expect(result).toMatchObject({ ok: true, side: 'expert', companyId: COMPANY_ID });
  });

  it('⚠ asks for `manage_engagement` — the ADMINISTRATIVE token — never `host_meetings`', async () => {
    mockHasEngagementCapability.mockResolvedValue(true);
    await authorizeMeetingParticipation({ meetingId: MEETING_ID, userId: USER_ID });

    expect(mockHasEngagementCapability).toHaveBeenCalledWith({ id: USER_ID }, 'manage_engagement', {
      contextType: 'case',
      contextId: ENGAGEMENT_ID,
    });
  });

  it('denies when the actor holds neither axis', async () => {
    const result = await authorizeMeetingParticipation({ meetingId: MEETING_ID, userId: USER_ID });
    expect(result).toEqual({ ok: false, code: 'meeting_not_found' });
  });
});

describe('authorizeMeetingParticipation — the ONE-LITERAL collapse (no oracle)', () => {
  /**
   * Every denial an outsider can reach must be BYTE-IDENTICAL on the wire. A distinct code
   * for any of these would confirm "this uuid is a real meeting" to a caller who is a member
   * of nothing — which is the whole of what a prober wants.
   */
  const DENIALS: ReadonlyArray<{ name: string; arrange: () => void }> = [
    {
      name: 'no such meeting (or soft-deleted)',
      arrange: () => mockMeetingFindById.mockResolvedValue(undefined),
    },
    {
      name: 'a meeting with NO contexts at all',
      arrange: () => mockListByMeeting.mockResolvedValue([]),
    },
    {
      name: 'an ADMIN-only meeting (no holder on either axis)',
      arrange: () =>
        mockListByMeeting.mockResolvedValue([{ contextType: 'admin', contextId: null }]),
    },
    {
      name: 'AMBIGUOUS contexts (two distinct engagement-grain rows)',
      arrange: () =>
        mockListByMeeting.mockResolvedValue([
          { contextType: 'case', contextId: ENGAGEMENT_ID },
          { contextType: 'package_session', contextId: OTHER_ENGAGEMENT_ID },
        ]),
    },
    {
      name: 'a context whose subject row does not resolve',
      arrange: () => mockEngagementFindById.mockResolvedValue(undefined),
    },
    {
      name: 'CROSS-TENANT — a real meeting the actor has no relationship with',
      arrange: () => {
        mockGetMemberRole.mockResolvedValue(undefined);
        mockHasEngagementCapability.mockResolvedValue(false);
      },
    },
    {
      name: 'a live member whose role lacks PARTICIPATE',
      arrange: () => mockGetMemberRole.mockResolvedValue('some_unknown_role'),
    },
  ];

  it.each(DENIALS)('$name → the identical `meeting_not_found` literal', async ({ arrange }) => {
    arrange();
    const result = await authorizeMeetingParticipation({ meetingId: MEETING_ID, userId: USER_ID });
    expect(result).toEqual({ ok: false, code: 'meeting_not_found' });
  });

  it('⚠ AMBIGUITY does NOT get its own 409 — see the §4.1 divergence note in the module docblock', async () => {
    // A distinct code here would be reachable BEFORE any membership is proven (the ambiguity
    // is precisely what stops us resolving a party to check against), so it would confirm the
    // meeting's existence to an outsider. `authorize-meeting-booking`'s `context_type_mismatch`
    // may be distinct only because it is reachable exclusively AFTER membership is proven.
    mockListByMeeting.mockResolvedValue([
      { contextType: 'case', contextId: ENGAGEMENT_ID },
      { contextType: 'project_kickoff', contextId: OTHER_ENGAGEMENT_ID },
    ]);
    const result = await authorizeMeetingParticipation({ meetingId: MEETING_ID, userId: USER_ID });
    expect(result).not.toMatchObject({ code: 'meeting_context_ambiguous' });
    expect(result).toEqual({ ok: false, code: 'meeting_not_found' });
  });

  it('there is no `forbidden` / 403 shape on this gate at all', async () => {
    const result = await authorizeMeetingParticipation({ meetingId: MEETING_ID, userId: USER_ID });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('meeting_not_found');
    }
  });
});

describe('authorizeMeetingParticipation — ORDERING is part of the contract', () => {
  it('⚠ never reads a subject row when the meeting does not resolve', async () => {
    mockMeetingFindById.mockResolvedValue(undefined);
    await authorizeMeetingParticipation({ meetingId: MEETING_ID, userId: USER_ID });

    expect(mockListByMeeting).not.toHaveBeenCalled();
    expect(mockEngagementFindById).not.toHaveBeenCalled();
    expect(mockGetMemberRole).not.toHaveBeenCalled();
  });

  it('⚠ never calls the ENGAGEMENT resolver on a context whose owning party did not resolve', async () => {
    // `resolveHostContext` is an IDENTITY ORACLE on an unvetted contextId — it truthfully
    // names another tenant's expert. The owning-party read must succeed first.
    mockEngagementFindById.mockResolvedValue(undefined);
    await authorizeMeetingParticipation({ meetingId: MEETING_ID, userId: USER_ID });

    expect(mockHasEngagementCapability).not.toHaveBeenCalled();
  });

  it('⚠ does NOT check meeting STATE — an `ended` meeting still passes the gate', async () => {
    // State is the SERVICE's check, deliberately AFTER authorization: refusing an ended
    // meeting here would let an unauthorized caller distinguish a real ended meeting from a
    // non-existent one by status code.
    mockMeetingFindById.mockResolvedValue(meetingRow({ status: 'ended' }));
    mockGetMemberRole.mockResolvedValue('member');

    const result = await authorizeMeetingParticipation({ meetingId: MEETING_ID, userId: USER_ID });
    expect(result).toMatchObject({ ok: true, side: 'client' });
  });

  it('threads the loaded meeting back so the caller never re-reads it', async () => {
    mockGetMemberRole.mockResolvedValue('member');
    const result = await authorizeMeetingParticipation({ meetingId: MEETING_ID, userId: USER_ID });

    expect(mockMeetingFindById).toHaveBeenCalledTimes(1);
    if (result.ok) {
      expect(result.meeting.id).toBe(MEETING_ID);
    }
  });
});

describe('authorizeMeetingParticipation — resolving the owning party per context grain', () => {
  it('ENGAGEMENT grain reads the engagement for both company and expert', async () => {
    mockGetMemberRole.mockResolvedValue('member');
    mockListByMeeting.mockResolvedValue([
      { contextType: 'retainer_checkin', contextId: ENGAGEMENT_ID },
    ]);

    const result = await authorizeMeetingParticipation({ meetingId: MEETING_ID, userId: USER_ID });

    expect(mockEngagementFindById).toHaveBeenCalledWith(ENGAGEMENT_ID);
    expect(result).toMatchObject({ ok: true, companyId: COMPANY_ID });
  });

  it('`project_discovery` reads the REQUEST for the company', async () => {
    mockListByMeeting.mockResolvedValue([
      { contextType: 'project_discovery', contextId: REQUEST_ID },
    ]);
    mockProjectRequestFindById.mockResolvedValue({
      companyId: COMPANY_ID,
      expertProfileId: EXPERT_PROFILE_ID,
    });
    mockGetMemberRole.mockResolvedValue('member');

    const result = await authorizeMeetingParticipation({ meetingId: MEETING_ID, userId: USER_ID });

    expect(mockProjectRequestFindById).toHaveBeenCalledWith(REQUEST_ID);
    expect(result).toMatchObject({ ok: true, side: 'client', companyId: COMPANY_ID });
  });

  it('a MATCH-routed `project_discovery` (null expert) still authorizes the CLIENT side', async () => {
    // The engagement axis yields NO HOLDER for a match-routed request, so admit/deny denies
    // everyone — but the client's own members must still be able to invite guests.
    mockListByMeeting.mockResolvedValue([
      { contextType: 'project_discovery', contextId: REQUEST_ID },
    ]);
    mockProjectRequestFindById.mockResolvedValue({
      companyId: COMPANY_ID,
      expertProfileId: null,
    });
    mockGetMemberRole.mockResolvedValue('member');

    const result = await authorizeMeetingParticipation({ meetingId: MEETING_ID, userId: USER_ID });
    expect(result).toMatchObject({ ok: true, side: 'client', expertProfileId: null });
  });

  it('⚠ `request_interaction` resolves the company via the REQUEST, never from the expert', async () => {
    // Inferring tenancy from the relationship's expert would authorize by DELIVERY IDENTITY
    // on the MEMBERSHIP axis — the axis confusion CLAUDE.md forbids.
    mockListByMeeting.mockResolvedValue([
      { contextType: 'request_interaction', contextId: RELATIONSHIP_ID },
    ]);
    mockRelationshipFindById.mockResolvedValue({
      projectRequestId: REQUEST_ID,
      expertProfileId: EXPERT_PROFILE_ID,
    });
    mockProjectRequestFindById.mockResolvedValue({
      companyId: COMPANY_ID,
      expertProfileId: EXPERT_PROFILE_ID,
    });
    mockGetMemberRole.mockResolvedValue('member');

    const result = await authorizeMeetingParticipation({ meetingId: MEETING_ID, userId: USER_ID });

    expect(mockRelationshipFindById).toHaveBeenCalledWith(RELATIONSHIP_ID);
    expect(mockProjectRequestFindById).toHaveBeenCalledWith(REQUEST_ID);
    expect(result).toMatchObject({ ok: true, companyId: COMPANY_ID });
  });

  it('denies when a `request_interaction` relationship resolves but its request does not', async () => {
    mockListByMeeting.mockResolvedValue([
      { contextType: 'request_interaction', contextId: RELATIONSHIP_ID },
    ]);
    mockRelationshipFindById.mockResolvedValue({
      projectRequestId: REQUEST_ID,
      expertProfileId: EXPERT_PROFILE_ID,
    });
    mockProjectRequestFindById.mockResolvedValue(undefined);

    const result = await authorizeMeetingParticipation({ meetingId: MEETING_ID, userId: USER_ID });
    expect(result).toEqual({ ok: false, code: 'meeting_not_found' });
  });

  it('⚠ prefers the ENGAGEMENT context on a kickoff meeting that still carries its discovery row', async () => {
    // The `any-of` rejection, end to end: a losing discovery candidate must not keep rights
    // over the kickoff meeting.
    mockListByMeeting.mockResolvedValue([
      { contextType: 'project_discovery', contextId: REQUEST_ID },
      { contextType: 'project_kickoff', contextId: ENGAGEMENT_ID },
    ]);
    mockGetMemberRole.mockResolvedValue('member');

    const result = await authorizeMeetingParticipation({ meetingId: MEETING_ID, userId: USER_ID });

    expect(result).toMatchObject({
      ok: true,
      subject: { contextType: 'project_kickoff', contextId: ENGAGEMENT_ID },
    });
    expect(mockProjectRequestFindById).not.toHaveBeenCalled();
  });
});
