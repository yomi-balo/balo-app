import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * BAL-466 (D3) — the `apps/web` wrapper's own suite. Mirrors
 * `apps/api`'s `authorize-meeting-participation.test.ts` shape at the seam this wrapper owns:
 * the `@balo/db` binding and the web engagement arm's total-but-not-complete switch.
 */

vi.mock('server-only', () => ({}));

const MEETING_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const COMPANY_ID = '33333333-3333-4333-8333-333333333333';
const ENGAGEMENT_ID = '44444444-4444-4444-8444-444444444444';
const EXPERT_PROFILE_ID = '88888888-8888-4888-8888-888888888888';

const {
  mockFindById,
  mockListByMeeting,
  mockGetMemberRole,
  mockResolveMeetingContextOwner,
  mockHasEngagementCapability,
  mockLogWarn,
} = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockListByMeeting: vi.fn(),
  mockGetMemberRole: vi.fn(),
  mockResolveMeetingContextOwner: vi.fn(),
  mockHasEngagementCapability: vi.fn(),
  mockLogWarn: vi.fn(),
}));

// ⚠ THE FACTORY LITERAL NAMES EXACTLY THE FOUR THINGS THIS WRAPPER USES.
vi.mock('@balo/db', () => ({
  meetingsRepository: { findById: mockFindById },
  meetingContextsRepository: { listByMeeting: mockListByMeeting },
  partyMembershipsRepository: { getMemberRole: mockGetMemberRole },
  resolveMeetingContextOwner: mockResolveMeetingContextOwner,
}));
vi.mock('@/lib/authz/engagement', () => ({
  hasEngagementCapability: mockHasEngagementCapability,
}));
vi.mock('@/lib/logging', () => ({
  log: { warn: mockLogWarn, error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { authorizeMeetingParticipation } from './meeting-participation';

function meetingRow(overrides: Record<string, unknown> = {}): unknown {
  return { id: MEETING_ID, status: 'scheduled', ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindById.mockResolvedValue(meetingRow());
  mockListByMeeting.mockResolvedValue([{ contextType: 'case', contextId: ENGAGEMENT_ID }]);
  mockResolveMeetingContextOwner.mockResolvedValue({
    companyId: COMPANY_ID,
    expertProfileId: EXPERT_PROFILE_ID,
  });
  mockGetMemberRole.mockResolvedValue(undefined);
  mockHasEngagementCapability.mockResolvedValue(false);
});

describe('authorizeMeetingParticipation (web) — the CLIENT side', () => {
  it('authorizes a live company member and resolves side=client', async () => {
    mockGetMemberRole.mockResolvedValue('member');

    const result = await authorizeMeetingParticipation({ meetingId: MEETING_ID, userId: USER_ID });

    expect(result).toMatchObject({
      ok: true,
      side: 'client',
      companyId: COMPANY_ID,
      expertProfileId: EXPERT_PROFILE_ID,
    });
  });

  it('reads membership via partyMembershipsRepository.getMemberRole(company, companyId, userId)', async () => {
    mockGetMemberRole.mockResolvedValue('owner');
    await authorizeMeetingParticipation({ meetingId: MEETING_ID, userId: USER_ID });
    expect(mockGetMemberRole).toHaveBeenCalledWith('company', COMPANY_ID, USER_ID);
  });
});

describe('authorizeMeetingParticipation (web) — the EXPERT side, ENGAGEMENT-GRAIN labels', () => {
  it.each(['case', 'project_kickoff', 'package_session', 'retainer_checkin'] as const)(
    '%s delegates to hasEngagementCapability with manage_engagement and an engagement-grain subject',
    async (contextType) => {
      mockListByMeeting.mockResolvedValue([{ contextType, contextId: ENGAGEMENT_ID }]);
      mockHasEngagementCapability.mockResolvedValue(true);

      const result = await authorizeMeetingParticipation({
        meetingId: MEETING_ID,
        userId: USER_ID,
      });

      expect(mockHasEngagementCapability).toHaveBeenCalledWith(
        { id: USER_ID },
        'manage_engagement',
        { contextType, contextId: ENGAGEMENT_ID }
      );
      expect(result).toMatchObject({ ok: true, side: 'expert' });
    }
  );
});

describe('authorizeMeetingParticipation (web) — the REQUEST-GRAIN gap, pinned so it cannot silently become true', () => {
  it.each(['project_discovery', 'request_interaction'] as const)(
    '%s NEVER calls hasEngagementCapability and always answers false (denied)',
    async (contextType) => {
      const REQUEST_ID = '66666666-6666-4666-8666-666666666666';
      mockListByMeeting.mockResolvedValue([{ contextType, contextId: REQUEST_ID }]);

      const result = await authorizeMeetingParticipation({
        meetingId: MEETING_ID,
        userId: USER_ID,
      });

      expect(mockHasEngagementCapability).not.toHaveBeenCalled();
      expect(result).toEqual({ ok: false, code: 'meeting_not_found' });
    }
  );

  /**
   * ⚠⚠ THE PROOF THIS GAP IS SAFE AT THE ONLY CONSUMER. The engagement arm can only ever
   * resolve an EXPERT-SIDE actor, and `resolveInCallDrawdown`'s third step
   * (`getSessionDrawdownState`) requires live membership of `credit_sessions.company_id` —
   * which no expert-side actor holds. So even if this arm resolved `true` for a request-grain
   * label, the composed gate would still deny one step later. This test pins that the arm
   * answers `false` here; `resolve-in-call-drawdown.test.ts`'s D10 suite pins the second half.
   */
  it('is fail-closed, not merely unimplemented — a denied outcome, not a throw', async () => {
    mockListByMeeting.mockResolvedValue([
      { contextType: 'project_discovery', contextId: '66666666-6666-4666-8666-666666666666' },
    ]);
    await expect(
      authorizeMeetingParticipation({ meetingId: MEETING_ID, userId: USER_ID })
    ).resolves.toEqual({ ok: false, code: 'meeting_not_found' });
  });
});

describe('authorizeMeetingParticipation (web) — every denial collapses into ONE literal', () => {
  const DENIALS: ReadonlyArray<{ name: string; arrange: () => void }> = [
    { name: 'no such meeting', arrange: () => mockFindById.mockResolvedValue(undefined) },
    { name: 'no contexts at all', arrange: () => mockListByMeeting.mockResolvedValue([]) },
    {
      name: 'the owning party does not resolve',
      arrange: () => mockResolveMeetingContextOwner.mockResolvedValue(undefined),
    },
    {
      name: 'cross-tenant — neither axis holds',
      arrange: () => {
        mockGetMemberRole.mockResolvedValue(undefined);
        mockHasEngagementCapability.mockResolvedValue(false);
      },
    },
  ];

  it.each(DENIALS)('$name → { ok: false, code: meeting_not_found }', async ({ arrange }) => {
    arrange();
    const result = await authorizeMeetingParticipation({ meetingId: MEETING_ID, userId: USER_ID });
    expect(result).toEqual({ ok: false, code: 'meeting_not_found' });
  });

  it('the denial SHAPE reaches log.warn and never the return value', async () => {
    mockFindById.mockResolvedValue(undefined);
    const result = await authorizeMeetingParticipation({ meetingId: MEETING_ID, userId: USER_ID });

    expect(result).toEqual({ ok: false, code: 'meeting_not_found' });
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Meeting participation denied',
      expect.objectContaining({ reason: 'no_meeting' })
    );
  });
});
