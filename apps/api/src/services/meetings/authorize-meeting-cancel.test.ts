import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockMeetingFindById,
  mockListByMeeting,
  mockEngagementFindById,
  mockProjectRequestFindById,
  mockRelationshipFindById,
  mockGetMemberRole,
  mockUserFindById,
  mockHasEngagementCapability,
} = vi.hoisted(() => ({
  mockMeetingFindById: vi.fn(),
  mockListByMeeting: vi.fn(),
  mockEngagementFindById: vi.fn(),
  mockProjectRequestFindById: vi.fn(),
  mockRelationshipFindById: vi.fn(),
  mockGetMemberRole: vi.fn(),
  mockUserFindById: vi.fn(),
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
  usersRepository: { findById: mockUserFindById },
}));
// ⚠ THE ENGAGEMENT RESOLVER IS MOCKED AT ITS OWN SEAM, not re-implemented. Its holder rule is
// pinned by `authorize-engagement-host.test.ts` and `expert-side-visibility.test.ts`; what THIS
// file owns is that the cancel gate CONSULTS that axis for the expert arm and no other.
vi.mock('./authorize-engagement-host.js', () => ({
  hasEngagementCapability: mockHasEngagementCapability,
}));
// ⚠ `@balo/shared/authz` and `@balo/shared/meetings` are deliberately NOT mocked — the real
// `roleHasCapability` / `platformRoleHasCapability` maps and the real precedence rule ARE what
// is under test at their steps.

import { ENGAGEMENT_CAPABILITIES } from '@balo/shared/authz';
import { authorizeMeetingCancel } from './authorize-meeting-cancel.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const MEETING_ID = '22222222-2222-4222-8222-222222222222';
const COMPANY_ID = '33333333-3333-4333-8333-333333333333';
const ENGAGEMENT_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_ENGAGEMENT_ID = '55555555-5555-4555-8555-555555555555';
const RELATIONSHIP_ID = '66666666-6666-4666-8666-666666666666';
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
  // Default: no arm grants. Every allow below opts IN to exactly one.
  mockGetMemberRole.mockResolvedValue(undefined);
  mockHasEngagementCapability.mockResolvedValue(false);
  mockUserFindById.mockResolvedValue({ id: USER_ID, platformRole: 'user' });
});

// ── The five denial shapes, all collapsing to ONE wire literal ─────────────────

describe('authorizeMeetingCancel — every denial is indistinguishable', () => {
  /**
   * ⚠ THE POINT OF THIS TABLE. `DenialReason` is a LOG field; the wire gets one literal. If any
   * shape ever answered differently, a caller holding a guessed uuid could distinguish "no such
   * meeting" from "not yours" — an existence oracle over every meeting on the platform.
   */
  const DENIALS = [
    {
      shape: 'no_meeting',
      arrange: () => mockMeetingFindById.mockResolvedValue(undefined),
    },
    {
      shape: 'no_context',
      arrange: () => mockListByMeeting.mockResolvedValue([]),
    },
    {
      shape: 'ambiguous_context',
      arrange: () =>
        mockListByMeeting.mockResolvedValue([
          { contextType: 'case', contextId: ENGAGEMENT_ID },
          { contextType: 'case', contextId: OTHER_ENGAGEMENT_ID },
        ]),
    },
    {
      shape: 'subject_unresolvable',
      arrange: () => mockEngagementFindById.mockResolvedValue(undefined),
    },
    {
      // ⚠ NOT `'member'` — every shipped company role holds `participate` (it is the base
      // bundle). The only way to reach `no_capability` on the client arm is a role the real
      // `@balo/shared/authz` map does not know, which is exactly the fail-closed default a
      // future role would land in until somebody writes its bundle.
      shape: 'no_capability',
      arrange: () => mockGetMemberRole.mockResolvedValue('some_future_role_with_no_bundle'),
    },
  ] as const;

  it.each(DENIALS)('denies $shape with the SAME meeting_not_found literal', async ({ arrange }) => {
    arrange();

    const result = await authorizeMeetingCancel({ meetingId: MEETING_ID, userId: USER_ID });

    expect(result).toEqual({ ok: false, code: 'meeting_not_found' });
  });

  it('the wire shape is byte-identical across ALL five denial reasons', async () => {
    const results = [];
    for (const { arrange } of DENIALS) {
      vi.clearAllMocks();
      mockMeetingFindById.mockResolvedValue(meetingRow());
      mockListByMeeting.mockResolvedValue([{ contextType: 'case', contextId: ENGAGEMENT_ID }]);
      mockEngagementFindById.mockResolvedValue({
        companyId: COMPANY_ID,
        expertProfileId: EXPERT_PROFILE_ID,
      });
      mockGetMemberRole.mockResolvedValue(undefined);
      mockHasEngagementCapability.mockResolvedValue(false);
      mockUserFindById.mockResolvedValue({ id: USER_ID, platformRole: 'user' });
      arrange();
      results.push(await authorizeMeetingCancel({ meetingId: MEETING_ID, userId: USER_ID }));
    }
    expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
  });
});

// ── ARM 1 — CLIENT, membership axis ───────────────────────────────────────────

describe('authorizeMeetingCancel — the CLIENT arm (membership axis)', () => {
  it.each(['owner', 'admin', 'member'])(
    'allows a company %s (every base-bundle role holds `participate`)',
    async (role) => {
      mockGetMemberRole.mockResolvedValue(role);

      const result = await authorizeMeetingCancel({ meetingId: MEETING_ID, userId: USER_ID });

      expect(result).toMatchObject({
        ok: true,
        actorRole: 'client',
        companyId: COMPANY_ID,
        expertProfileId: EXPERT_PROFILE_ID,
      });
    }
  );

  it('denies a non-member of the owning company', async () => {
    mockGetMemberRole.mockResolvedValue(undefined);

    const result = await authorizeMeetingCancel({ meetingId: MEETING_ID, userId: USER_ID });

    expect(result).toEqual({ ok: false, code: 'meeting_not_found' });
  });

  it('denies a membership role that does NOT hold `participate`', async () => {
    // The map is the real one — an unknown role grants nothing.
    mockGetMemberRole.mockResolvedValue('some_future_role_with_no_bundle');

    const result = await authorizeMeetingCancel({ meetingId: MEETING_ID, userId: USER_ID });

    expect(result).toEqual({ ok: false, code: 'meeting_not_found' });
  });

  it('reads membership against the company resolved from the CONTEXT, never from input', async () => {
    mockGetMemberRole.mockResolvedValue('member');

    await authorizeMeetingCancel({ meetingId: MEETING_ID, userId: USER_ID });

    expect(mockGetMemberRole).toHaveBeenCalledWith('company', COMPANY_ID, USER_ID);
  });
});

// ── ARM 2 — EXPERT, engagement axis ───────────────────────────────────────────

describe('authorizeMeetingCancel — the EXPERT arm (engagement axis)', () => {
  it('allows a `manage_engagement` holder', async () => {
    mockHasEngagementCapability.mockResolvedValue(true);

    const result = await authorizeMeetingCancel({ meetingId: MEETING_ID, userId: USER_ID });

    expect(result).toMatchObject({ ok: true, actorRole: 'expert' });
  });

  it('asks the ENGAGEMENT axis for `manage_engagement`, on the resolved primary context', async () => {
    // ⚠ NEVER `host_meetings` — that is the live/in-meeting token. ADR-1046 names "expert-side
    // cancel" as a `manage_engagement` act specifically.
    mockHasEngagementCapability.mockResolvedValue(true);

    await authorizeMeetingCancel({ meetingId: MEETING_ID, userId: USER_ID });

    expect(mockHasEngagementCapability).toHaveBeenCalledWith(
      { id: USER_ID },
      ENGAGEMENT_CAPABILITIES.MANAGE_ENGAGEMENT,
      { contextType: 'case', contextId: ENGAGEMENT_ID }
    );
  });

  it('denies a NON-holder — the resolver’s `false` is final on this arm', async () => {
    // This is how an agency member with role `expert` is refused: visibility is deliberately
    // wider than the act set (ADR-1046 §7), and the resolver — not this gate — draws that line.
    mockHasEngagementCapability.mockResolvedValue(false);

    const result = await authorizeMeetingCancel({ meetingId: MEETING_ID, userId: USER_ID });

    expect(result).toEqual({ ok: false, code: 'meeting_not_found' });
  });

  it('covers a REQUEST-grain context too — the api resolver implements all seven arms', async () => {
    mockListByMeeting.mockResolvedValue([
      { contextType: 'request_interaction', contextId: RELATIONSHIP_ID },
    ]);
    mockRelationshipFindById.mockResolvedValue({
      companyId: COMPANY_ID,
      expertProfileId: EXPERT_PROFILE_ID,
    });
    mockHasEngagementCapability.mockResolvedValue(true);

    const result = await authorizeMeetingCancel({ meetingId: MEETING_ID, userId: USER_ID });

    expect(result).toMatchObject({ ok: true, actorRole: 'expert' });
    expect(mockHasEngagementCapability).toHaveBeenCalledWith(
      { id: USER_ID },
      ENGAGEMENT_CAPABILITIES.MANAGE_ENGAGEMENT,
      { contextType: 'request_interaction', contextId: RELATIONSHIP_ID }
    );
  });
});

// ── ARM 3 — ADMIN, platform axis ──────────────────────────────────────────────

describe('authorizeMeetingCancel — the ADMIN arm (platform axis)', () => {
  it.each(['admin', 'super_admin'])('allows platformRole %s', async (platformRole) => {
    mockUserFindById.mockResolvedValue({ id: USER_ID, platformRole });

    const result = await authorizeMeetingCancel({ meetingId: MEETING_ID, userId: USER_ID });

    expect(result).toMatchObject({ ok: true, actorRole: 'admin' });
  });

  it('denies a plain `user` — the real PLATFORM_ROLE_CAPABILITIES map decides', async () => {
    mockUserFindById.mockResolvedValue({ id: USER_ID, platformRole: 'user' });

    const result = await authorizeMeetingCancel({ meetingId: MEETING_ID, userId: USER_ID });

    expect(result).toEqual({ ok: false, code: 'meeting_not_found' });
  });

  it('denies when the user row itself is missing or soft-deleted', async () => {
    mockUserFindById.mockResolvedValue(undefined);

    const result = await authorizeMeetingCancel({ meetingId: MEETING_ID, userId: USER_ID });

    expect(result).toEqual({ ok: false, code: 'meeting_not_found' });
  });

  it('⚠ still allows when the SUBJECT ROW is unresolvable — the override reaches what parties cannot', async () => {
    // A missing / soft-deleted engagement row: both party arms are skipped, and `companyId`
    // comes back `null`. Refusing here would make the override unreachable for exactly the
    // bookings it exists for.
    mockEngagementFindById.mockResolvedValue(undefined);
    mockUserFindById.mockResolvedValue({ id: USER_ID, platformRole: 'admin' });

    const result = await authorizeMeetingCancel({ meetingId: MEETING_ID, userId: USER_ID });

    expect(result).toMatchObject({
      ok: true,
      actorRole: 'admin',
      companyId: null,
      expertProfileId: null,
    });
  });

  it('⚠ an AMBIGUOUS primary context denies EVERY arm, admin included — fail-closed', async () => {
    mockListByMeeting.mockResolvedValue([
      { contextType: 'case', contextId: ENGAGEMENT_ID },
      { contextType: 'case', contextId: OTHER_ENGAGEMENT_ID },
    ]);
    mockUserFindById.mockResolvedValue({ id: USER_ID, platformRole: 'super_admin' });

    const result = await authorizeMeetingCancel({ meetingId: MEETING_ID, userId: USER_ID });

    expect(result).toEqual({ ok: false, code: 'meeting_not_found' });
  });

  it('⚠ an `admin`-CONTEXT-ONLY meeting denies every arm — `selectPrimaryMeetingContext` yields none', async () => {
    // `admin` scores precedence 0 and is unrepresentable as a primary context, so this is a
    // `no_context` denial, not an admin allow. Harmless: `admin` is not bookable.
    mockListByMeeting.mockResolvedValue([{ contextType: 'admin', contextId: null }]);
    mockUserFindById.mockResolvedValue({ id: USER_ID, platformRole: 'admin' });

    const result = await authorizeMeetingCancel({ meetingId: MEETING_ID, userId: USER_ID });

    expect(result).toEqual({ ok: false, code: 'meeting_not_found' });
  });
});

// ── Arm ORDER and read economy ────────────────────────────────────────────────

describe('authorizeMeetingCancel — arm precedence is client → expert → admin', () => {
  it('an actor holding ALL THREE resolves as `client` — the first match wins', async () => {
    mockGetMemberRole.mockResolvedValue('owner');
    mockHasEngagementCapability.mockResolvedValue(true);
    mockUserFindById.mockResolvedValue({ id: USER_ID, platformRole: 'super_admin' });

    const result = await authorizeMeetingCancel({ meetingId: MEETING_ID, userId: USER_ID });

    expect(result).toMatchObject({ ok: true, actorRole: 'client' });
  });

  it('an expert who is also a platform admin resolves as `expert`', async () => {
    mockHasEngagementCapability.mockResolvedValue(true);
    mockUserFindById.mockResolvedValue({ id: USER_ID, platformRole: 'admin' });

    const result = await authorizeMeetingCancel({ meetingId: MEETING_ID, userId: USER_ID });

    expect(result).toMatchObject({ ok: true, actorRole: 'expert' });
  });

  it('the ADMIN read is skipped entirely when a party arm already matched', async () => {
    mockGetMemberRole.mockResolvedValue('member');

    await authorizeMeetingCancel({ meetingId: MEETING_ID, userId: USER_ID });

    expect(mockUserFindById).not.toHaveBeenCalled();
  });

  it('the ENGAGEMENT read is skipped entirely when the client arm already matched', async () => {
    mockGetMemberRole.mockResolvedValue('member');

    await authorizeMeetingCancel({ meetingId: MEETING_ID, userId: USER_ID });

    expect(mockHasEngagementCapability).not.toHaveBeenCalled();
  });

  it('⚠ the CLIENT arm is SKIPPED (not asked) when no owning party resolved', async () => {
    // Nothing may widen for a non-admin actor: with no company there is no membership question
    // to ask, and asking one against a `null` company is how a cross-tenant allow appears.
    mockEngagementFindById.mockResolvedValue(undefined);

    await authorizeMeetingCancel({ meetingId: MEETING_ID, userId: USER_ID });

    expect(mockGetMemberRole).not.toHaveBeenCalled();
  });
});

// ── The threaded result ───────────────────────────────────────────────────────

describe('authorizeMeetingCancel — what it threads back', () => {
  it('returns the meeting, the primary context and both party ids, so nothing is re-read', async () => {
    mockGetMemberRole.mockResolvedValue('owner');

    const result = await authorizeMeetingCancel({ meetingId: MEETING_ID, userId: USER_ID });

    expect(result).toMatchObject({
      ok: true,
      meeting: { id: MEETING_ID, status: 'scheduled' },
      subject: { contextType: 'case', contextId: ENGAGEMENT_ID },
      companyId: COMPANY_ID,
      expertProfileId: EXPERT_PROFILE_ID,
    });
  });

  it('⚠ NEVER consults meeting STATUS — that check belongs to the route, strictly after this', async () => {
    // Membership before state. A cancelled meeting still passes the GATE; the route's
    // `resolveCancelRefusal` is what answers 409.
    mockMeetingFindById.mockResolvedValue(meetingRow({ status: 'cancelled' }));
    mockGetMemberRole.mockResolvedValue('owner');

    const result = await authorizeMeetingCancel({ meetingId: MEETING_ID, userId: USER_ID });

    expect(result).toMatchObject({ ok: true, actorRole: 'client' });
  });

  it('carries `expertProfileId: null` for a match-routed discovery, which names nobody', async () => {
    mockListByMeeting.mockResolvedValue([
      { contextType: 'project_discovery', contextId: OTHER_ENGAGEMENT_ID },
    ]);
    mockProjectRequestFindById.mockResolvedValue({ companyId: COMPANY_ID, expertProfileId: null });
    mockGetMemberRole.mockResolvedValue('owner');

    const result = await authorizeMeetingCancel({ meetingId: MEETING_ID, userId: USER_ID });

    expect(result).toMatchObject({ ok: true, actorRole: 'client', expertProfileId: null });
  });
});
