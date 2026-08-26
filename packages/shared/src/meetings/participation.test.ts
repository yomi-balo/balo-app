import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  resolveMeetingParticipation,
  type MeetingParticipationDenialReason,
  type MeetingParticipationReads,
} from './participation';
import type { MeetingContextOwner } from './context-owner';

/**
 * BAL-466 (D3) — the pure core's own suite. Hand-written fake reads, mirroring
 * `apps/api`'s `authorize-meeting-participation.test.ts` shape SO THE TWO CANNOT DRIFT — if a
 * new denial reason or a new authorization branch appears here without an equivalent there (or
 * vice versa), the divergence is a bug in one of the two suites, not a feature.
 */

const USER_ID = '11111111-1111-4111-8111-111111111111';
const MEETING_ID = '22222222-2222-4222-8222-222222222222';
const COMPANY_ID = '33333333-3333-4333-8333-333333333333';
const ENGAGEMENT_ID = '44444444-4444-4444-8444-444444444444';
const EXPERT_PROFILE_ID = '88888888-8888-4888-8888-888888888888';

interface FakeMeeting {
  readonly id: string;
  readonly status: string;
}

const mockFindMeeting = vi.fn();
const mockListMeetingContexts = vi.fn();
const mockResolveOwner = vi.fn();
const mockFindCompanyMemberRole = vi.fn();
const mockHoldsEngagementCapability = vi.fn();

const READS: MeetingParticipationReads<FakeMeeting> = {
  findMeeting: mockFindMeeting,
  listMeetingContexts: mockListMeetingContexts,
  resolveOwner: mockResolveOwner,
  findCompanyMemberRole: mockFindCompanyMemberRole,
  holdsEngagementCapability: mockHoldsEngagementCapability,
};

function meetingRow(overrides: Partial<FakeMeeting> = {}): FakeMeeting {
  return { id: MEETING_ID, status: 'scheduled', ...overrides };
}

function owner(overrides: Partial<MeetingContextOwner> = {}): MeetingContextOwner {
  return { companyId: COMPANY_ID, expertProfileId: EXPERT_PROFILE_ID, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindMeeting.mockResolvedValue(meetingRow());
  mockListMeetingContexts.mockResolvedValue([{ contextType: 'case', contextId: ENGAGEMENT_ID }]);
  mockResolveOwner.mockResolvedValue(owner());
  mockFindCompanyMemberRole.mockResolvedValue(undefined);
  mockHoldsEngagementCapability.mockResolvedValue(false);
});

describe('resolveMeetingParticipation — the CLIENT side (membership axis)', () => {
  it('authorizes a live company member and resolves side=client', async () => {
    mockFindCompanyMemberRole.mockResolvedValue('member');

    const result = await resolveMeetingParticipation(
      { meetingId: MEETING_ID, userId: USER_ID },
      READS
    );

    expect(result).toMatchObject({
      outcome: 'authorized',
      side: 'client',
      companyId: COMPANY_ID,
      expertProfileId: EXPERT_PROFILE_ID,
      subject: { contextType: 'case', contextId: ENGAGEMENT_ID },
    });
  });

  it('resolves membership on the COMPANY the owning party names, and threads (companyId, userId) through', async () => {
    mockFindCompanyMemberRole.mockResolvedValue('owner');
    await resolveMeetingParticipation({ meetingId: MEETING_ID, userId: USER_ID }, READS);
    expect(mockFindCompanyMemberRole).toHaveBeenCalledWith(COMPANY_ID, USER_ID);
  });

  it('⚠ never consults the ENGAGEMENT axis once company membership succeeds — the sides cannot both fire', async () => {
    mockFindCompanyMemberRole.mockResolvedValue('member');
    await resolveMeetingParticipation({ meetingId: MEETING_ID, userId: USER_ID }, READS);
    expect(mockHoldsEngagementCapability).not.toHaveBeenCalled();
  });

  it('denies a live member whose role lacks PARTICIPATE (the real capability map decides)', async () => {
    mockFindCompanyMemberRole.mockResolvedValue('some_unknown_role');
    const result = await resolveMeetingParticipation(
      { meetingId: MEETING_ID, userId: USER_ID },
      READS
    );
    expect(result).toEqual({
      outcome: 'denied',
      reason: 'no_capability',
      fields: { userId: USER_ID, meetingId: MEETING_ID, companyId: COMPANY_ID, side: 'client' },
    });
  });

  it('accepts every shipped company role, because PARTICIPATE is the base member bundle', async () => {
    for (const role of ['owner', 'admin', 'member']) {
      vi.clearAllMocks();
      mockFindMeeting.mockResolvedValue(meetingRow());
      mockListMeetingContexts.mockResolvedValue([
        { contextType: 'case', contextId: ENGAGEMENT_ID },
      ]);
      mockResolveOwner.mockResolvedValue(owner());
      mockFindCompanyMemberRole.mockResolvedValue(role);

      const result = await resolveMeetingParticipation(
        { meetingId: MEETING_ID, userId: USER_ID },
        READS
      );
      expect(result).toMatchObject({ outcome: 'authorized', side: 'client' });
    }
  });
});

describe('resolveMeetingParticipation — the EXPERT side (engagement axis)', () => {
  it('authorizes a manage_engagement holder and resolves side=expert', async () => {
    mockHoldsEngagementCapability.mockResolvedValue(true);

    const result = await resolveMeetingParticipation(
      { meetingId: MEETING_ID, userId: USER_ID },
      READS
    );

    expect(result).toMatchObject({ outcome: 'authorized', side: 'expert', companyId: COMPANY_ID });
  });

  it('is reached ONLY after company membership fails, with the resolved subject', async () => {
    mockHoldsEngagementCapability.mockResolvedValue(true);
    await resolveMeetingParticipation({ meetingId: MEETING_ID, userId: USER_ID }, READS);

    expect(mockHoldsEngagementCapability).toHaveBeenCalledWith(USER_ID, {
      contextType: 'case',
      contextId: ENGAGEMENT_ID,
    });
  });

  it('denies when the actor holds neither axis', async () => {
    const result = await resolveMeetingParticipation(
      { meetingId: MEETING_ID, userId: USER_ID },
      READS
    );
    expect(result).toEqual({
      outcome: 'denied',
      reason: 'cross_tenant',
      fields: {
        userId: USER_ID,
        meetingId: MEETING_ID,
        companyId: COMPANY_ID,
        contextType: 'case',
      },
    });
  });
});

describe('resolveMeetingParticipation — every denial reason is reachable, and ordering is contract', () => {
  it('no_meeting short-circuits BEFORE listMeetingContexts', async () => {
    mockFindMeeting.mockResolvedValue(undefined);
    const result = await resolveMeetingParticipation(
      { meetingId: MEETING_ID, userId: USER_ID },
      READS
    );

    expect(result).toMatchObject({ outcome: 'denied', reason: 'no_meeting' });
    expect(mockListMeetingContexts).not.toHaveBeenCalled();
    expect(mockResolveOwner).not.toHaveBeenCalled();
    expect(mockFindCompanyMemberRole).not.toHaveBeenCalled();
  });

  it('no_context — a meeting with no contexts at all (or admin-only)', async () => {
    mockListMeetingContexts.mockResolvedValue([{ contextType: 'admin', contextId: null }]);
    const result = await resolveMeetingParticipation(
      { meetingId: MEETING_ID, userId: USER_ID },
      READS
    );
    expect(result).toMatchObject({ outcome: 'denied', reason: 'no_context' });
  });

  it('ambiguous_context — two distinct engagement-grain rows, and it does NOT get its own code', async () => {
    mockListMeetingContexts.mockResolvedValue([
      { contextType: 'case', contextId: ENGAGEMENT_ID },
      { contextType: 'package_session', contextId: '55555555-5555-4555-8555-555555555555' },
    ]);
    const result = await resolveMeetingParticipation(
      { meetingId: MEETING_ID, userId: USER_ID },
      READS
    );
    expect(result).toMatchObject({ outcome: 'denied', reason: 'ambiguous_context' });
  });

  it('subject_unresolvable short-circuits BEFORE holdsEngagementCapability (no identity oracle)', async () => {
    mockResolveOwner.mockResolvedValue(undefined);
    const result = await resolveMeetingParticipation(
      { meetingId: MEETING_ID, userId: USER_ID },
      READS
    );

    expect(result).toMatchObject({ outcome: 'denied', reason: 'subject_unresolvable' });
    expect(mockFindCompanyMemberRole).not.toHaveBeenCalled();
    expect(mockHoldsEngagementCapability).not.toHaveBeenCalled();
  });

  it('cross_tenant — a real meeting the actor has no relationship with', async () => {
    mockFindCompanyMemberRole.mockResolvedValue(undefined);
    mockHoldsEngagementCapability.mockResolvedValue(false);
    const result = await resolveMeetingParticipation(
      { meetingId: MEETING_ID, userId: USER_ID },
      READS
    );
    expect(result).toMatchObject({ outcome: 'denied', reason: 'cross_tenant' });
  });

  // ⚠ F10 (review fix round) — REWRITTEN. The prior version compared two hand-written array
  // literals containing the same six strings and never called `resolveMeetingParticipation` —
  // it would still pass if the module stopped returning `no_capability`, stopped returning
  // `ambiguous_context`, or was deleted outright. This version RE-RUNS each of the five denial
  // arrangements from the tests above (self-contained — it does not depend on `beforeEach`
  // ordering) and collects the ACTUAL `result.reason` the function returns, then compares that
  // set against the declared union. A regressed or deleted branch now fails HERE, by name.
  it('⚠ TOTALITY — every member of MeetingParticipationDenialReason is reachable from the function itself', async () => {
    const actualReasons = new Set<MeetingParticipationDenialReason>();

    // no_meeting
    vi.clearAllMocks();
    mockFindMeeting.mockResolvedValue(undefined);
    const noMeeting = await resolveMeetingParticipation(
      { meetingId: MEETING_ID, userId: USER_ID },
      READS
    );
    if (noMeeting.outcome === 'denied') actualReasons.add(noMeeting.reason);

    // no_context
    vi.clearAllMocks();
    mockFindMeeting.mockResolvedValue(meetingRow());
    mockListMeetingContexts.mockResolvedValue([{ contextType: 'admin', contextId: null }]);
    const noContext = await resolveMeetingParticipation(
      { meetingId: MEETING_ID, userId: USER_ID },
      READS
    );
    if (noContext.outcome === 'denied') actualReasons.add(noContext.reason);

    // ambiguous_context
    vi.clearAllMocks();
    mockFindMeeting.mockResolvedValue(meetingRow());
    mockListMeetingContexts.mockResolvedValue([
      { contextType: 'case', contextId: ENGAGEMENT_ID },
      { contextType: 'package_session', contextId: '55555555-5555-4555-8555-555555555555' },
    ]);
    const ambiguous = await resolveMeetingParticipation(
      { meetingId: MEETING_ID, userId: USER_ID },
      READS
    );
    if (ambiguous.outcome === 'denied') actualReasons.add(ambiguous.reason);

    // subject_unresolvable
    vi.clearAllMocks();
    mockFindMeeting.mockResolvedValue(meetingRow());
    mockListMeetingContexts.mockResolvedValue([{ contextType: 'case', contextId: ENGAGEMENT_ID }]);
    mockResolveOwner.mockResolvedValue(undefined);
    const unresolvable = await resolveMeetingParticipation(
      { meetingId: MEETING_ID, userId: USER_ID },
      READS
    );
    if (unresolvable.outcome === 'denied') actualReasons.add(unresolvable.reason);

    // cross_tenant
    vi.clearAllMocks();
    mockFindMeeting.mockResolvedValue(meetingRow());
    mockListMeetingContexts.mockResolvedValue([{ contextType: 'case', contextId: ENGAGEMENT_ID }]);
    mockResolveOwner.mockResolvedValue(owner());
    mockFindCompanyMemberRole.mockResolvedValue(undefined);
    mockHoldsEngagementCapability.mockResolvedValue(false);
    const crossTenant = await resolveMeetingParticipation(
      { meetingId: MEETING_ID, userId: USER_ID },
      READS
    );
    if (crossTenant.outcome === 'denied') actualReasons.add(crossTenant.reason);

    // no_capability
    vi.clearAllMocks();
    mockFindMeeting.mockResolvedValue(meetingRow());
    mockListMeetingContexts.mockResolvedValue([{ contextType: 'case', contextId: ENGAGEMENT_ID }]);
    mockResolveOwner.mockResolvedValue(owner());
    mockFindCompanyMemberRole.mockResolvedValue('some_unknown_role');
    const noCapability = await resolveMeetingParticipation(
      { meetingId: MEETING_ID, userId: USER_ID },
      READS
    );
    if (noCapability.outcome === 'denied') actualReasons.add(noCapability.reason);

    const declared: readonly MeetingParticipationDenialReason[] = [
      'no_meeting',
      'no_context',
      'ambiguous_context',
      'subject_unresolvable',
      'cross_tenant',
      'no_capability',
    ];
    expect(actualReasons).toEqual(new Set(declared));
  });
});

describe('resolveMeetingParticipation — ORDERING is part of the contract', () => {
  // ⚠ F11 (review fix round) — REWRITTEN. The prior body called the function twice and checked
  // `result.meeting.id`, which asserted no ordering at all — and that lone assertion sat INSIDE
  // `if (result.outcome === 'authorized')`, so an arrangement that stopped authorizing would run
  // ZERO expectations and still pass green. This version asserts the REAL ordering via
  // `mock.invocationCallOrder`, and hoists the outcome check out of the conditional so a
  // regression to `denied` fails the test rather than silently skipping it.
  it('⚠ AUTHORIZATION runs strictly after meeting → context → owner resolution', async () => {
    mockFindCompanyMemberRole.mockResolvedValue('member');
    const result = await resolveMeetingParticipation(
      { meetingId: MEETING_ID, userId: USER_ID },
      READS
    );

    expect(result.outcome).toBe('authorized');
    if (result.outcome !== 'authorized') throw new Error('expected authorized'); // narrows for TS
    expect(result.meeting.id).toBe(MEETING_ID);

    const [meetingCall] = mockFindMeeting.mock.invocationCallOrder;
    const [contextsCall] = mockListMeetingContexts.mock.invocationCallOrder;
    const [ownerCall] = mockResolveOwner.mock.invocationCallOrder;
    const [membershipCall] = mockFindCompanyMemberRole.mock.invocationCallOrder;
    if (
      meetingCall === undefined ||
      contextsCall === undefined ||
      ownerCall === undefined ||
      membershipCall === undefined
    ) {
      throw new Error('expected every read to have been called exactly once');
    }
    expect(meetingCall).toBeLessThan(contextsCall);
    expect(contextsCall).toBeLessThan(ownerCall);
    expect(ownerCall).toBeLessThan(membershipCall);
  });

  it('⚠ does NOT check meeting STATE — an `ended` meeting still passes', async () => {
    mockFindMeeting.mockResolvedValue(meetingRow({ status: 'ended' }));
    mockFindCompanyMemberRole.mockResolvedValue('member');

    const result = await resolveMeetingParticipation(
      { meetingId: MEETING_ID, userId: USER_ID },
      READS
    );
    expect(result).toMatchObject({ outcome: 'authorized', side: 'client' });
  });
});

describe('resolveMeetingParticipation — the match-routed project_discovery shape', () => {
  it('a match-routed project_discovery (expertProfileId: null) still authorizes the CLIENT side', async () => {
    mockListMeetingContexts.mockResolvedValue([
      { contextType: 'project_discovery', contextId: '66666666-6666-4666-8666-666666666666' },
    ]);
    mockResolveOwner.mockResolvedValue(owner({ expertProfileId: null }));
    mockFindCompanyMemberRole.mockResolvedValue('member');

    const result = await resolveMeetingParticipation(
      { meetingId: MEETING_ID, userId: USER_ID },
      READS
    );

    expect(result).toMatchObject({ outcome: 'authorized', side: 'client', expertProfileId: null });
  });
});

describe('resolveMeetingParticipation — never throws, never logs', () => {
  it('is a pure decision — the module exports no logger and this suite mocks none', async () => {
    mockFindCompanyMemberRole.mockResolvedValue('member');
    await expect(
      resolveMeetingParticipation({ meetingId: MEETING_ID, userId: USER_ID }, READS)
    ).resolves.toBeDefined();
  });
});
