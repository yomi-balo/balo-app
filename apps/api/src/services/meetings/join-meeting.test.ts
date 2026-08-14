import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockMeetingFindById,
  mockListByMeeting,
  mockEngagementFindById,
  mockGuestFindLiveByTokenHash,
  mockGuestCountLiveByMeeting,
  mockGuestCountPendingLobbyKnocks,
  mockGuestClaimLobbyPlace,
  mockFindNamesByIds,
  mockCompanyFindNameById,
  mockExpertFindDisplayProfileById,
  mockAuthorizeMeetingParticipation,
  mockHasEngagementCapability,
  mockGetMemberRole,
  mockTrackServer,
  mockPublish,
} = vi.hoisted(() => ({
  mockMeetingFindById: vi.fn(),
  mockListByMeeting: vi.fn(),
  mockEngagementFindById: vi.fn(),
  mockGuestFindLiveByTokenHash: vi.fn(),
  mockGuestCountLiveByMeeting: vi.fn(),
  mockGuestCountPendingLobbyKnocks: vi.fn(),
  mockGuestClaimLobbyPlace: vi.fn(),
  mockFindNamesByIds: vi.fn(),
  mockCompanyFindNameById: vi.fn(),
  mockExpertFindDisplayProfileById: vi.fn(),
  mockAuthorizeMeetingParticipation: vi.fn(),
  mockHasEngagementCapability: vi.fn(),
  mockGetMemberRole: vi.fn(),
  mockTrackServer: vi.fn(),
  mockPublish: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
// ⚠ THE FACTORY MUST NAME EVERY EXPORT THE IMPORT GRAPH TOUCHES — a vitest factory mock
// throws on any omitted one. `guest-participation.js` is loaded FOR REAL (we import the real
// `canonicalEmail` from it rather than writing a second definition), so its repositories are
// listed here too even though this suite never calls them.
vi.mock('@balo/db', () => ({
  meetingsRepository: { findById: mockMeetingFindById },
  meetingContextsRepository: { listByMeeting: mockListByMeeting },
  engagementsRepository: { findById: mockEngagementFindById },
  meetingGuestsRepository: {
    findLiveByTokenHash: mockGuestFindLiveByTokenHash,
    countLiveByMeeting: mockGuestCountLiveByMeeting,
    countPendingLobbyKnocks: mockGuestCountPendingLobbyKnocks,
    claimLobbyPlace: mockGuestClaimLobbyPlace,
    createMany: vi.fn(),
    listLiveByMeeting: vi.fn(),
    findLiveById: vi.fn(),
    revoke: vi.fn(),
    decideAdmission: vi.fn(),
  },
  usersRepository: { findNamesByIds: mockFindNamesByIds, findById: vi.fn() },
  agenciesRepository: { getSummaryById: vi.fn() },
  // ⚠ `findByEngagementId` is BAL-435's context-label read, reached through
  // `resolveMeetingContextLabel` on the member arm. A vitest factory mock throws on any export
  // the import graph touches but the factory omits.
  caseEngagementsRepository: { findById: vi.fn(), findByEngagementId: vi.fn() },
  // ⚠ BAL-435 (R10): `findNameById` / `findDisplayProfileById` are the waiting-stage
  // counterparty reads, reached through `resolveWaitingCounterparty` on the member arm. A vitest
  // factory mock throws on any export the import graph touches but the factory omits.
  companiesRepository: { findById: vi.fn(), findNameById: mockCompanyFindNameById },
  expertsRepository: {
    findProfileById: vi.fn(),
    findDisplayProfileById: mockExpertFindDisplayProfileById,
  },
  partyDomainsRepository: { listByParty: vi.fn() },
  partyMembershipsRepository: { getMemberRole: mockGetMemberRole, listAdminUserIds: vi.fn() },
  projectRequestsRepository: { findById: vi.fn() },
  requestExpertRelationshipsRepository: { findById: vi.fn() },
}));
vi.mock('@balo/analytics/server', () => ({
  trackServer: mockTrackServer,
  GUEST_SERVER_EVENTS: {
    GUEST_ADMITTED: 'guest_admitted',
    GUEST_DENIED: 'guest_denied',
    GUEST_INVITE_OPENED: 'guest_invite_opened',
    GUEST_INVITED: 'guest_invited',
    GUEST_JOINED: 'guest_joined',
    GUEST_REMOVED: 'guest_removed',
  },
  MEETING_SERVER_EVENTS: {
    MEETING_PROVISIONED: 'meeting_provisioned',
    MEETING_PROVISION_FAILED: 'meeting_provision_failed',
    MEETING_JOIN_GRANTED: 'meeting_join_granted',
  },
}));
vi.mock('../../notifications/index.js', () => ({
  notificationEvents: { publish: mockPublish },
}));
vi.mock('./authorize-meeting-participation.js', () => ({
  authorizeMeetingParticipation: mockAuthorizeMeetingParticipation,
}));
vi.mock('./authorize-engagement-host.js', () => ({
  hasEngagementCapability: mockHasEngagementCapability,
}));
// ⚠ `./meeting-liveness.js` is deliberately NOT mocked — the REAL rule is what the
// engagement-lifecycle tests below are asserting, and it needs only `engagementsRepository`.
// ⚠ `@balo/shared/meetings` is NOT mocked either: the real `dailyRoomNameForMeeting` and
// `dailyParticipantIdFor` ARE what the token-claim assertions are about.

import { DailyApiError, DailyConfigError } from '../daily/errors.js';
import { createJwtMinter, readMeetingTokenClaims } from '../../test/mocks/daily-token-jwt.js';
// ⚠ `parseDailyParticipantId` ONLY — the READER. `dailyParticipantIdFor` (the WRITER) is
// deliberately NOT imported: every identity assertion here decodes what the service actually
// sent, and rebuilding the expected value with the same helper that produced it would compare a
// function against itself and pass for any encoding, including a broken one.
import { MAX_LOBBY_QUEUE, parseDailyParticipantId } from '@balo/shared/meetings';
import { claimLobbyPlace, joinMeetingAsGuest, joinMeetingAsMember } from './join-meeting.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const MEETING_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_MEETING_ID = '99999999-9999-4999-8999-999999999999';
const COMPANY_ID = '33333333-3333-4333-8333-333333333333';
const ENGAGEMENT_ID = '44444444-4444-4444-8444-444444444444';
const GUEST_ID = '55555555-5555-4555-8555-555555555555';
const EXPERT_PROFILE_ID = '88888888-8888-4888-8888-888888888888';

const ROOM_NAME = 'balo-22222222222242228222222222222222';
const ROOM_URL = `https://balo.daily.co/${ROOM_NAME}`;
const RAW_TOKEN = 'a'.repeat(43);

/** Far enough in the future that the 24h token window is always open. */
const SCHEDULED_START = new Date(Date.now() + 60 * 60 * 1000);
const SCHEDULED_END = new Date(SCHEDULED_START.getTime() + 60 * 60 * 1000);

function meetingRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: MEETING_ID,
    status: 'scheduled',
    scheduledStart: SCHEDULED_START,
    scheduledEnd: SCHEDULED_END,
    dailyRoomName: ROOM_NAME,
    joinUrl: ROOM_URL,
    ...overrides,
  };
}

function gateOk(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    side: 'client',
    meeting: meetingRow(),
    subject: { contextType: 'case', contextId: ENGAGEMENT_ID },
    companyId: COMPANY_ID,
    expertProfileId: EXPERT_PROFILE_ID,
    ...overrides,
  };
}

function guestRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: GUEST_ID,
    meetingId: MEETING_ID,
    email: 'sam@cloudpeak.example',
    name: 'Sam Rivera',
    party: 'client',
    participationRole: 'guest',
    accessScope: 'meeting',
    inviteChannel: 'email',
    admission: 'pre_admitted',
    accessCount: 0,
    ...overrides,
  };
}

/**
 * `findLiveByTokenHash` returns the guest AND the meeting. The stored `tokenHash` must equal
 * the hash the service derives from the raw token, or the constant-time re-compare refuses.
 */
async function tokenRow(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const { hashGuestToken } = await import('../../lib/guest-token.js');
  return {
    guest: guestRow({ tokenHash: hashGuestToken(RAW_TOKEN), ...overrides }),
    meeting: meetingRow(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthorizeMeetingParticipation.mockResolvedValue(gateOk());
  mockEngagementFindById.mockResolvedValue({ id: ENGAGEMENT_ID, status: 'active' });
  mockHasEngagementCapability.mockResolvedValue(false);
  // BAL-134 — no company membership by default, so `canEndMeeting`'s client arm is false unless
  // a test says otherwise. `undefined` is what `getMemberRole` really answers for a non-member.
  mockGetMemberRole.mockResolvedValue(undefined);
  mockFindNamesByIds.mockResolvedValue([{ firstName: 'Dana', lastName: 'Okoro' }]);
  // ⚠ BAL-435 (R10) — the waiting-stage counterparty reads.
  mockExpertFindDisplayProfileById.mockResolvedValue({ id: EXPERT_PROFILE_ID, userId: USER_ID });
  mockCompanyFindNameById.mockResolvedValue({ id: COMPANY_ID, name: 'Northwind Industrial' });
  mockListByMeeting.mockResolvedValue([{ contextType: 'case', contextId: ENGAGEMENT_ID }]);
  mockMeetingFindById.mockResolvedValue(meetingRow());
  mockGuestCountLiveByMeeting.mockResolvedValue(0);
  mockGuestCountPendingLobbyKnocks.mockResolvedValue(0);
  mockGuestClaimLobbyPlace.mockResolvedValue({ id: GUEST_ID, meetingId: MEETING_ID });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// joinMeetingAsMember
// ─────────────────────────────────────────────────────────────────────────────────────────

describe('joinMeetingAsMember — the happy paths', () => {
  it('mints for a non-owner member', async () => {
    const minter = createJwtMinter();

    const result = await joinMeetingAsMember({ meetingId: MEETING_ID, userId: USER_ID, minter });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grant.isOwner).toBe(false);
    expect(result.grant.roomUrl).toBe(ROOM_URL);
    expect(result.grant.token.length).toBeGreaterThan(0);
  });

  it('mints an OWNER token when hasEngagementCapability(HOST_MEETINGS) says so', async () => {
    mockHasEngagementCapability.mockResolvedValue(true);
    const minter = createJwtMinter();

    const result = await joinMeetingAsMember({ meetingId: MEETING_ID, userId: USER_ID, minter });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grant.isOwner).toBe(true);
  });
});

/**
 * ⚠⚠⚠ BAL-134 / ADR-1049 (D3) — THE SHARPEST TRAP IN THE FEATURE, PINNED.
 *
 * `isOwner` is the ONLY input to the Daily meeting token's `is_owner` property, and Daily
 * `is_owner` confers VENDOR-LEVEL ROOM POWERS (eject, recording control). `canEndMeeting` is a
 * SEPARATE, SIXTH grant field that is true for CLIENT PRINCIPALS too. **Merging them, or
 * "simplifying" the mint to read `canEndMeeting`, would mint Daily owner tokens for the PAYING
 * SIDE.** ADR-1049's "this is what BAL-435's bare `isOwner` prop becomes" is unsafe as written
 * and is deliberately not implemented as a rename.
 *
 * The decisive row is the third one: a client principal gets `canEndMeeting: true` and
 * `isOwner: false`, AND THE MINTED TOKEN CARRIES `is_owner: false`. That is the assertion that
 * fails the moment anybody unifies the two booleans.
 */
describe('⚠⚠ joinMeetingAsMember — `canEndMeeting` vs `isOwner` (BAL-134 D3)', () => {
  it('neither — a member with no capability and no company role', async () => {
    const result = await joinMeetingAsMember({
      meetingId: MEETING_ID,
      userId: USER_ID,
      minter: createJwtMinter(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grant.isOwner).toBe(false);
    expect(result.grant.canEndMeeting).toBe(false);
  });

  it('the EXPERT HOST holds both — the engagement axis satisfies each independently', async () => {
    mockHasEngagementCapability.mockResolvedValue(true);

    const result = await joinMeetingAsMember({
      meetingId: MEETING_ID,
      userId: USER_ID,
      minter: createJwtMinter(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grant.isOwner).toBe(true);
    expect(result.grant.canEndMeeting).toBe(true);
  });

  it('⚠⚠ a CLIENT PRINCIPAL may END but is NEVER a Daily owner — the token proves it', async () => {
    mockHasEngagementCapability.mockResolvedValue(false);
    // A live company member. `CONSUME_CREDITS` sits in the base member bundle (D6).
    mockGetMemberRole.mockResolvedValue('member');
    const minter = createJwtMinter();

    const result = await joinMeetingAsMember({ meetingId: MEETING_ID, userId: USER_ID, minter });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grant.canEndMeeting).toBe(true);
    expect(result.grant.isOwner).toBe(false);
    // ⚠ THE LINE THAT MATTERS: what actually reached the mint.
    expect(minter.requests[0]?.isOwner).toBe(false);
  });

  it('the `is_owner` ANALYTICS property stays on `isOwner`, not on `canEndMeeting`', async () => {
    mockHasEngagementCapability.mockResolvedValue(false);
    mockGetMemberRole.mockResolvedValue('owner');

    await joinMeetingAsMember({
      meetingId: MEETING_ID,
      userId: USER_ID,
      minter: createJwtMinter(),
    });

    expect(mockTrackServer).toHaveBeenCalledWith(
      'meeting_join_granted',
      expect.objectContaining({ is_owner: false })
    );
  });

  it('⚠ goes through `authorizeMeetingParticipation` — the TENANCY gate, not `resolveHostContext`', async () => {
    // `resolveHostContext` is an identity oracle with NO tenancy check, and
    // `meeting_contexts.context_id` has no FK and no RLS. The capability call must receive a
    // subject THAT GATE resolved, never a caller-supplied one.
    mockHasEngagementCapability.mockResolvedValue(true);

    await joinMeetingAsMember({
      meetingId: MEETING_ID,
      userId: USER_ID,
      minter: createJwtMinter(),
    });

    expect(mockAuthorizeMeetingParticipation).toHaveBeenCalledWith({
      meetingId: MEETING_ID,
      userId: USER_ID,
    });
    expect(mockHasEngagementCapability).toHaveBeenCalledWith({ id: USER_ID }, 'host_meetings', {
      contextType: 'case',
      contextId: ENGAGEMENT_ID,
    });
  });

  it('⚠ reads the name through `findNamesByIds` — NEVER `findById`, which hydrates workosId and email', async () => {
    // This value flows into a token that reaches a browser (memory
    // `reference_drizzle_with_hydration_leaks_secrets`).
    await joinMeetingAsMember({
      meetingId: MEETING_ID,
      userId: USER_ID,
      minter: createJwtMinter(),
    });

    expect(mockFindNamesByIds).toHaveBeenCalledWith([USER_ID]);
  });

  it('falls back to `Participant` for a nameless member — NEVER to their email address', async () => {
    mockFindNamesByIds.mockResolvedValue([{ firstName: null, lastName: null }]);
    const minter = createJwtMinter();

    await joinMeetingAsMember({ meetingId: MEETING_ID, userId: USER_ID, minter });

    expect(minter.requests[0]?.userName).toBe('Participant');
  });

  it('emits `meeting_join_granted` once per mint', async () => {
    mockHasEngagementCapability.mockResolvedValue(true);

    await joinMeetingAsMember({
      meetingId: MEETING_ID,
      userId: USER_ID,
      minter: createJwtMinter(),
    });

    expect(mockTrackServer).toHaveBeenCalledWith('meeting_join_granted', {
      meeting_id: MEETING_ID,
      context_type: 'case',
      is_owner: true,
      distinct_id: USER_ID,
    });
  });
});

/**
 * BAL-435 ruling R10 — the waiting stage's inputs.
 *
 * ⚠⚠ WHY THIS IS A MONEY-SURFACE TEST, NOT A COSMETIC ONE. With no `viewerRole` the web frame
 * hard-coded `absentParty="expert"` for every viewer, so the DELIVERING EXPERT read the CLIENT's
 * "You won't be charged for waiting" — which is meaningless to the person being paid, and is the
 * exact misreading BAL-134 says makes an expert leave at minute eight and forfeit a settlement
 * they had already earned.
 */
describe('joinMeetingAsMember — ⚠⚠ R10: who is missing, and from when', () => {
  it('passes the GATE resolved side through as `viewerRole` — never a lens', async () => {
    const result = await joinMeetingAsMember({
      meetingId: MEETING_ID,
      userId: USER_ID,
      minter: createJwtMinter(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // `authorizeMeetingParticipation` resolved `side: 'client'` in `gateOk()`.
    expect(result.viewerRole).toBe('client');
    expect(result.scheduledStart).toBe(SCHEDULED_START.toISOString());
  });

  it('a CLIENT viewer is waiting for the delivering EXPERT, by first name', async () => {
    const result = await joinMeetingAsMember({
      meetingId: MEETING_ID,
      userId: USER_ID,
      minter: createJwtMinter(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(mockExpertFindDisplayProfileById).toHaveBeenCalledWith(EXPERT_PROFILE_ID);
    expect(result.counterpartyFirstName).toBe('Dana');
    // ⚠ The client side names no individual, so its company is never read on this arm.
    expect(mockCompanyFindNameById).not.toHaveBeenCalled();
  });

  it('an EXPERT viewer is waiting for the CLIENT COMPANY — a party, never an invented person', async () => {
    mockAuthorizeMeetingParticipation.mockResolvedValue(gateOk({ side: 'expert' }));

    const result = await joinMeetingAsMember({
      meetingId: MEETING_ID,
      userId: USER_ID,
      minter: createJwtMinter(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.viewerRole).toBe('expert');
    expect(result.counterpartyFirstName).toBe('Northwind Industrial');
    expect(mockCompanyFindNameById).toHaveBeenCalledWith(COMPANY_ID);
  });

  it('⚠ a match-routed discovery names NO expert, and that is null rather than a guess', async () => {
    mockAuthorizeMeetingParticipation.mockResolvedValue(
      gateOk({
        subject: { contextType: 'project_discovery', contextId: ENGAGEMENT_ID },
        expertProfileId: null,
      })
    );

    const result = await joinMeetingAsMember({
      meetingId: MEETING_ID,
      userId: USER_ID,
      minter: createJwtMinter(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.counterpartyFirstName).toBeNull();
    expect(mockExpertFindDisplayProfileById).not.toHaveBeenCalled();
  });

  it('⚠⚠ a repository failure degrades to null and NEVER fails the join', async () => {
    mockExpertFindDisplayProfileById.mockRejectedValue(new Error('db down'));

    const result = await joinMeetingAsMember({
      meetingId: MEETING_ID,
      userId: USER_ID,
      minter: createJwtMinter(),
    });

    // A name is decoration on a surface whose job is to connect a call.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.counterpartyFirstName).toBeNull();
    expect(result.grant.token.length).toBeGreaterThan(0);
  });

  it('⚠ an empty or whitespace name is null, not an empty name in the copy', async () => {
    mockFindNamesByIds.mockResolvedValue([{ firstName: '   ', lastName: 'Okoro' }]);

    const result = await joinMeetingAsMember({
      meetingId: MEETING_ID,
      userId: USER_ID,
      minter: createJwtMinter(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.counterpartyFirstName).toBeNull();
  });
});

describe('joinMeetingAsMember — every gate failure is ONE literal', () => {
  it('answers `meeting_not_found` when the tenancy gate refuses', async () => {
    mockAuthorizeMeetingParticipation.mockResolvedValue({ ok: false, code: 'meeting_not_found' });
    const minter = createJwtMinter();

    await expect(
      joinMeetingAsMember({ meetingId: MEETING_ID, userId: USER_ID, minter })
    ).resolves.toEqual({ ok: false, code: 'meeting_not_found' });
    expect(minter.requests).toHaveLength(0);
  });

  it.each(['ended', 'cancelled'] as const)(
    'answers `meeting_not_open_for_join` for a `%s` meeting',
    async (status) => {
      mockAuthorizeMeetingParticipation.mockResolvedValue(
        gateOk({ meeting: meetingRow({ status }) })
      );

      await expect(
        joinMeetingAsMember({ meetingId: MEETING_ID, userId: USER_ID, minter: createJwtMinter() })
      ).resolves.toEqual({ ok: false, code: 'meeting_not_open_for_join' });
    }
  );

  it('⚠⚠ REFUSES the DELIVERING EXPERT of a CANCELLED ENGAGEMENT — the BAL-132 lifecycle failure', async () => {
    // `hasEngagementCapability` NEVER reads `engagements.status`, so this actor genuinely
    // still holds `host_meetings`. Without `assertMeetingJoinable` they would be minted a
    // Daily OWNER token for an engagement that was called off.
    mockHasEngagementCapability.mockResolvedValue(true);
    mockEngagementFindById.mockResolvedValue({ id: ENGAGEMENT_ID, status: 'cancelled' });
    const minter = createJwtMinter();

    await expect(
      joinMeetingAsMember({ meetingId: MEETING_ID, userId: USER_ID, minter })
    ).resolves.toEqual({ ok: false, code: 'meeting_not_open_for_join' });
    expect(minter.requests).toHaveLength(0);
  });

  it.each([
    ['a null joinUrl', { joinUrl: null }],
    ['a null dailyRoomName', { dailyRoomName: null }],
    ['both null (a `provisioned: false` booking)', { joinUrl: null, dailyRoomName: null }],
    ['a room name that DIVERGES from the derived one', { dailyRoomName: 'balo-somethingelse' }],
  ])('answers `meeting_not_provisioned` for %s', async (_label, overrides) => {
    mockAuthorizeMeetingParticipation.mockResolvedValue(gateOk({ meeting: meetingRow(overrides) }));

    await expect(
      joinMeetingAsMember({ meetingId: MEETING_ID, userId: USER_ID, minter: createJwtMinter() })
    ).resolves.toEqual({ ok: false, code: 'meeting_not_provisioned' });
  });

  it.each([
    ['a DailyApiError', new DailyApiError('POST', '/meeting-tokens', 500, 'vendor exploded')],
    ['a DailyConfigError', new DailyConfigError('DAILY_API_KEY is not set')],
  ])('maps %s to `meeting_token_unavailable` and leaks nothing', async (_label, error) => {
    const failing = { createMeetingToken: vi.fn().mockRejectedValue(error) };

    const result = await joinMeetingAsMember({
      meetingId: MEETING_ID,
      userId: USER_ID,
      minter: failing,
    });

    expect(result).toEqual({ ok: false, code: 'meeting_token_unavailable' });
    // ⚠ The RESULT carries no uuid and no vendor text — only the fixed literal.
    expect(JSON.stringify(result)).not.toContain(MEETING_ID);
    expect(JSON.stringify(result)).not.toContain('vendor exploded');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// ⚠⚠ ADDENDUM A2.1 — DECODE THE MINTED TOKEN AND ASSERT ITS CLAIMS
// ─────────────────────────────────────────────────────────────────────────────────────────

describe('⚠⚠ the MINTED TOKEN`s claims, DECODED (not re-serialised)', () => {
  /**
   * ⚠ THE ASSERTIONS BELOW READ A REAL JWT BACK THROUGH `jose`'s `decodeJwt`, and read the
   * identity back through `parseDailyParticipantId` — a DIFFERENT function from the
   * `dailyParticipantIdFor` that wrote it. Rebuilding the expected value with the same helper
   * that produced it would compare a function against itself and pass for any encoding,
   * including a broken one.
   */
  it('a MEMBER token carries the derived room, a `u`-tagged identity, is_owner and a seconds `exp`', async () => {
    mockHasEngagementCapability.mockResolvedValue(true);
    const minter = createJwtMinter();

    const result = await joinMeetingAsMember({ meetingId: MEETING_ID, userId: USER_ID, minter });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const claims = readMeetingTokenClaims(result.grant.token);

    // ROOM — matches `dailyRoomNameForMeeting(meetingId)`, which is a pure function of the id.
    expect(claims.room_name).toBe(ROOM_NAME);

    // IDENTITY — the Decision-1 encoding, ROUND-TRIPPED through the parser.
    expect(parseDailyParticipantId(String(claims.user_id))).toEqual({
      kind: 'user',
      id: USER_ID,
    });

    // OWNER — matches the capability verdict.
    expect(claims.is_owner).toBe(true);

    // EXP — scheduled end + 24h, IN SECONDS.
    expect(claims.exp).toBe(Math.floor((SCHEDULED_END.getTime() + 24 * 60 * 60 * 1000) / 1000));

    // ⚠ ABSENT — `eject_at_token_exp` would convert a rejoin window into a mid-call ejection.
    expect(claims.eject_at_token_exp).toBeUndefined();
  });

  it('a GUEST token carries a `g`-tagged identity that round-trips to the GUEST row id', async () => {
    mockGuestFindLiveByTokenHash.mockResolvedValue(await tokenRow());
    const minter = createJwtMinter();

    const result = await joinMeetingAsGuest({
      meetingId: MEETING_ID,
      rawGuestToken: RAW_TOKEN,
      minter,
    });
    expect(result.ok && result.state === 'admitted').toBe(true);
    if (!result.ok || result.state !== 'admitted') return;

    const claims = readMeetingTokenClaims(result.grant.token);

    expect(parseDailyParticipantId(String(claims.user_id))).toEqual({
      kind: 'guest',
      id: GUEST_ID,
    });
    expect(claims.is_owner).toBe(false);
    expect(claims.room_name).toBe(ROOM_NAME);
    expect(claims.eject_at_token_exp).toBeUndefined();
  });

  it('⚠ the two kinds are DISTINGUISHABLE even for the SAME uuid — the whole point of the tag', async () => {
    // The identity encoding exists because `users.id` and `meeting_guests.id` are both uuids
    // and BAL-134 must route them to different columns held apart by a CHECK.
    //
    // ⚠⚠ DRIVEN THROUGH **THIS MODULE'S TWO JOIN ARMS**, NOT THROUGH
    // `dailyParticipantIdFor` / `parseDailyParticipantId` DIRECTLY. The previous version called
    // the shared helpers and asserted they disagree — which tests `@balo/shared/meetings`
    // (where those helpers have their own suite) and exercises NOTHING in the file under test.
    // It would have stayed green through this module tagging both arms `'user'`. The uuid is
    // deliberately the SAME on both sides, which is the collision the tag exists to survive.
    const sharedId = MEETING_ID;

    const memberMinter = createJwtMinter();
    await joinMeetingAsMember({ meetingId: MEETING_ID, userId: sharedId, minter: memberMinter });

    mockGuestFindLiveByTokenHash.mockResolvedValue(await tokenRow({ id: sharedId }));
    const guestMinter = createJwtMinter();
    await joinMeetingAsGuest({
      meetingId: MEETING_ID,
      rawGuestToken: RAW_TOKEN,
      minter: guestMinter,
    });

    const memberSent = String(memberMinter.requests[0]?.participantId);
    const guestSent = String(guestMinter.requests[0]?.participantId);

    // Same uuid in, two different wire identities out.
    expect(memberSent).not.toBe(guestSent);
    expect(parseDailyParticipantId(memberSent)).toEqual({ kind: 'user', id: sharedId });
    expect(parseDailyParticipantId(guestSent)).toEqual({ kind: 'guest', id: sharedId });
  });

  it('never puts a bare uuid on the wire — a bare uuid does not parse, by design', async () => {
    const minter = createJwtMinter();
    await joinMeetingAsMember({ meetingId: MEETING_ID, userId: USER_ID, minter });

    const sent = String(minter.requests[0]?.participantId);
    expect(sent).not.toBe(USER_ID);
    expect(parseDailyParticipantId(USER_ID)).toBeNull();
    expect(parseDailyParticipantId(sent)).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// joinMeetingAsGuest
// ─────────────────────────────────────────────────────────────────────────────────────────

describe('joinMeetingAsGuest — the admission switch (DECISION 2)', () => {
  it('a `pre_admitted` invitee mints on the FIRST call — no visible token step', async () => {
    mockGuestFindLiveByTokenHash.mockResolvedValue(await tokenRow({ admission: 'pre_admitted' }));

    const result = await joinMeetingAsGuest({
      meetingId: MEETING_ID,
      rawGuestToken: RAW_TOKEN,
      minter: createJwtMinter(),
    });

    expect(result.ok && result.state).toBe('admitted');
  });

  it('⚠⚠ a `pending` guest gets `waiting` — AND NOTHING ELSE HAPPENS AT ALL', async () => {
    // THE WHOLE PROPERTY IS THE ABSENCE. "The queue enforces via token issuance, not UI"
    // means: no mint, no analytics, no side effect. Asserting the returned state alone would
    // not distinguish this from a mint whose result was discarded.
    mockGuestFindLiveByTokenHash.mockResolvedValue(await tokenRow({ admission: 'pending' }));
    const minter = createJwtMinter();

    const result = await joinMeetingAsGuest({
      meetingId: MEETING_ID,
      rawGuestToken: RAW_TOKEN,
      minter,
    });

    expect(result).toEqual({ ok: true, state: 'waiting' });
    expect(minter.requests).toHaveLength(0);
    expect(mockTrackServer).not.toHaveBeenCalled();
  });

  it('pending → admitted: the SAME call mints once the host decides', async () => {
    const minter = createJwtMinter();
    mockGuestFindLiveByTokenHash.mockResolvedValue(await tokenRow({ admission: 'pending' }));

    const waiting = await joinMeetingAsGuest({
      meetingId: MEETING_ID,
      rawGuestToken: RAW_TOKEN,
      minter,
    });
    expect(waiting).toEqual({ ok: true, state: 'waiting' });

    mockGuestFindLiveByTokenHash.mockResolvedValue(await tokenRow({ admission: 'admitted' }));
    const admitted = await joinMeetingAsGuest({
      meetingId: MEETING_ID,
      rawGuestToken: RAW_TOKEN,
      minter,
    });

    expect(admitted.ok && admitted.state).toBe('admitted');
    expect(minter.requests).toHaveLength(1);
  });

  it('⚠ a DENIED token is filtered by the finder, so it answers `meeting_not_found`', async () => {
    // `findLiveByTokenHash` excludes `denied` rows entirely — which is what makes "denial can
    // never produce a mint on any path" structural rather than a branch someone could delete.
    mockGuestFindLiveByTokenHash.mockResolvedValue(undefined);
    const minter = createJwtMinter();

    await expect(
      joinMeetingAsGuest({ meetingId: MEETING_ID, rawGuestToken: RAW_TOKEN, minter })
    ).resolves.toEqual({ ok: false, code: 'meeting_not_found' });
    expect(minter.requests).toHaveLength(0);
  });
});

describe('joinMeetingAsGuest — a guest is NEVER a host', () => {
  it.each(['client', 'expert'] as const)(
    '⚠ isOwner is false for a guest whose stored party is `%s`',
    async (party) => {
      // An expert-side GUEST is a colleague, not the delivering expert. Owner rights are the
      // engagement axis's answer about DELIVERY IDENTITY, and a guest row is not on that axis
      // at all — so the capability seam is not even consulted.
      mockGuestFindLiveByTokenHash.mockResolvedValue(await tokenRow({ party }));
      mockHasEngagementCapability.mockResolvedValue(true);
      const minter = createJwtMinter();

      const result = await joinMeetingAsGuest({
        meetingId: MEETING_ID,
        rawGuestToken: RAW_TOKEN,
        minter,
      });

      expect(result.ok && result.state === 'admitted').toBe(true);
      if (!result.ok || result.state !== 'admitted') return;

      expect(result.grant.isOwner).toBe(false);
      expect(minter.requests[0]?.isOwner).toBe(false);
      // And the DECODED claim agrees — the request and the credential cannot disagree.
      expect(readMeetingTokenClaims(result.grant.token).is_owner).toBe(false);
      // ⚠ The capability seam is not even consulted for a guest.
      expect(mockHasEngagementCapability).not.toHaveBeenCalled();
    }
  );

  /**
   * ⚠⚠ BAL-134 — A GUEST MAY NEVER END A MEETING (edge case 24). Hard-coded `false` on this
   * arm exactly as `isOwner` is, and NOT because a token check said so: a guest holds no
   * `company_members` row, so every membership token fails closed, and they are not on the
   * engagement axis at all. The ADR's intent, delivered structurally. The assertion that the
   * membership seam is never even READ is the half that would survive somebody "helpfully"
   * resolving end authority for guests.
   */
  it.each(['client', 'expert'] as const)(
    '⚠⚠ canEndMeeting is false for a guest whose stored party is `%s` — Leave only',
    async (party) => {
      mockGuestFindLiveByTokenHash.mockResolvedValue(await tokenRow({ party }));
      mockHasEngagementCapability.mockResolvedValue(true);
      mockGetMemberRole.mockResolvedValue('owner');

      const result = await joinMeetingAsGuest({
        meetingId: MEETING_ID,
        rawGuestToken: RAW_TOKEN,
        minter: createJwtMinter(),
      });

      expect(result.ok && result.state === 'admitted').toBe(true);
      if (!result.ok || result.state !== 'admitted') return;

      expect(result.grant.canEndMeeting).toBe(false);
      // ⚠ NEITHER AXIS IS CONSULTED — the answer is structural, not computed.
      expect(mockHasEngagementCapability).not.toHaveBeenCalled();
      expect(mockGetMemberRole).not.toHaveBeenCalled();
    }
  );
});

describe('joinMeetingAsGuest — token scoping', () => {
  it('⚠ a token for meeting A presented at meeting B`s URL answers `meeting_not_found`', async () => {
    // Otherwise ONE valid guest credential would be a universal probe for "is this uuid a
    // meeting?" across the whole platform.
    mockGuestFindLiveByTokenHash.mockResolvedValue(await tokenRow());
    const minter = createJwtMinter();

    await expect(
      joinMeetingAsGuest({ meetingId: OTHER_MEETING_ID, rawGuestToken: RAW_TOKEN, minter })
    ).resolves.toEqual({ ok: false, code: 'meeting_not_found' });
    expect(minter.requests).toHaveLength(0);
  });

  it('refuses when the stored hash disagrees with the presented token (the constant-time re-check)', async () => {
    mockGuestFindLiveByTokenHash.mockResolvedValue({
      guest: guestRow({ tokenHash: 'f'.repeat(64) }),
      meeting: meetingRow(),
    });

    await expect(
      joinMeetingAsGuest({
        meetingId: MEETING_ID,
        rawGuestToken: RAW_TOKEN,
        minter: createJwtMinter(),
      })
    ).resolves.toEqual({ ok: false, code: 'meeting_not_found' });
  });

  it('answers `meeting_not_found` when no primary context resolves (an ADMIN-only meeting)', async () => {
    mockGuestFindLiveByTokenHash.mockResolvedValue(await tokenRow());
    mockListByMeeting.mockResolvedValue([{ contextType: 'admin', contextId: null }]);

    await expect(
      joinMeetingAsGuest({
        meetingId: MEETING_ID,
        rawGuestToken: RAW_TOKEN,
        minter: createJwtMinter(),
      })
    ).resolves.toEqual({ ok: false, code: 'meeting_not_found' });
  });
});

describe('joinMeetingAsGuest — `guest_joined`', () => {
  it.each([
    {
      inviteChannel: 'email',
      admission: 'pre_admitted',
      join_method: 'magic_link',
      admitted: false,
    },
    { inviteChannel: 'link', admission: 'admitted', join_method: 'link_share', admitted: true },
  ] as const)(
    'derives join_method=$join_method and admitted=$admitted from the PERSISTED columns',
    async ({ inviteChannel, admission, join_method, admitted }) => {
      mockGuestFindLiveByTokenHash.mockResolvedValue(await tokenRow({ inviteChannel, admission }));

      await joinMeetingAsGuest({
        meetingId: MEETING_ID,
        rawGuestToken: RAW_TOKEN,
        minter: createJwtMinter(),
      });

      expect(mockTrackServer).toHaveBeenCalledWith('guest_joined', {
        // ⚠⚠ THE `party` KEY IS **OMITTED ENTIRELY** ON A LINK-SHARE JOIN.
        // `meeting_guests.party` is NOT NULL and CHECK-narrowed, so the lobby writer stores the
        // PLACEHOLDER `client` — not because a side was resolved (a bare meeting URL carries no
        // sharer identity) but because the column demands something. Emitting that placeholder
        // makes a dashboard filtered on `party = client` silently include every link-share
        // joiner: WRONG, not merely coarse.
        ...(join_method === 'link_share' ? {} : { party: 'client' }),
        join_method,
        admitted,
        // ⚠ `meeting_guests.id` — a guest has NO user id.
        distinct_id: GUEST_ID,
      });
    }
  );

  /**
   * ⚠⚠ OMITTED, NOT `null`. The previous encoding sent `party: null` while its comment claimed
   * the property was "ABSENT rather than wrong" — but `trackServer` spreads this object
   * straight into `capture({ properties })`, so PostHog received a real `"party": null`: it
   * satisfies a `party is set` filter and creates a `null` bucket in every breakdown. This
   * asserts KEY ABSENCE against the actual argument, which is the only form that can tell the
   * two encodings apart (`toHaveBeenCalledWith` treats an absent key and an explicit
   * `undefined` as equal, and would have treated `null` as a mismatch only by luck of the
   * fixture).
   */
  it('⚠⚠ OMITS the `party` key on a link_share join — never sends null', async () => {
    mockGuestFindLiveByTokenHash.mockResolvedValue(
      await tokenRow({ inviteChannel: 'link', admission: 'admitted' })
    );

    await joinMeetingAsGuest({
      meetingId: MEETING_ID,
      rawGuestToken: RAW_TOKEN,
      minter: createJwtMinter(),
    });

    const [call] = mockTrackServer.mock.calls;
    const properties = call?.[1] as Record<string, unknown>;
    expect(properties).toBeDefined();
    expect('party' in properties).toBe(false);
    // Non-vacuity: the event really did fire, with the discriminator that replaces `party`.
    expect(properties['join_method']).toBe('link_share');
  });

  it('DOES send `party` on a magic_link join — the side is genuinely resolved there', async () => {
    mockGuestFindLiveByTokenHash.mockResolvedValue(
      await tokenRow({ inviteChannel: 'email', admission: 'pre_admitted' })
    );

    await joinMeetingAsGuest({
      meetingId: MEETING_ID,
      rawGuestToken: RAW_TOKEN,
      minter: createJwtMinter(),
    });

    const [call] = mockTrackServer.mock.calls;
    const properties = call?.[1] as Record<string, unknown>;
    expect('party' in (properties ?? {})).toBe(true);
    expect(properties?.['party']).toBe('client');
  });

  it('fires exactly ONCE per mint', async () => {
    mockGuestFindLiveByTokenHash.mockResolvedValue(await tokenRow());

    await joinMeetingAsGuest({
      meetingId: MEETING_ID,
      rawGuestToken: RAW_TOKEN,
      minter: createJwtMinter(),
    });

    expect(mockTrackServer).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// claimLobbyPlace
// ─────────────────────────────────────────────────────────────────────────────────────────

describe('claimLobbyPlace — the anonymous knock', () => {
  it('returns the raw lobby token to its bearer', async () => {
    const result = await claimLobbyPlace({
      meetingId: MEETING_ID,
      name: 'Sam Rivera',
      email: 'Sam@CloudPeak.example',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lobbyToken.length).toBeGreaterThan(20);
  });

  it('⚠ canonicalises the email through the SHARED helper before it reaches the unique index', async () => {
    // `meeting_guest_meeting_email_live_idx` matches the STORED BYTES and is the only bound
    // on queue-flooding. A second definition of "the same address" here would let
    // `Sam@x.example` and `sam@x.example` both insert.
    await claimLobbyPlace({
      meetingId: MEETING_ID,
      name: 'Sam Rivera',
      email: '  Sam@CloudPeak.example  ',
    });

    expect(mockGuestClaimLobbyPlace).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'sam@cloudpeak.example' })
    );
  });

  it('⚠ writes party `client` as a PLACEHOLDER, with accessScope `meeting` — never `engagement`', async () => {
    await claimLobbyPlace({ meetingId: MEETING_ID, name: 'Sam', email: 'sam@x.example' });

    expect(mockGuestClaimLobbyPlace).toHaveBeenCalledWith(
      expect.objectContaining({ party: 'client', accessScope: 'meeting' })
    );
  });

  it('derives expiresAt from the MEETING (+7d), not from the mint instant', async () => {
    await claimLobbyPlace({ meetingId: MEETING_ID, name: 'Sam', email: 'sam@x.example' });

    const call = mockGuestClaimLobbyPlace.mock.calls[0]?.[0] as { expiresAt: Date };
    expect(call.expiresAt.getTime()).toBe(SCHEDULED_END.getTime() + 7 * 24 * 60 * 60 * 1000);
  });

  it('stores only the HASH — the raw token never reaches @balo/db', async () => {
    const result = await claimLobbyPlace({
      meetingId: MEETING_ID,
      name: 'Sam',
      email: 'sam@x.example',
    });

    // ⚠⚠ GUARD FIRST, THEN ASSERT. The previous form was
    // `expect(result.ok && call.tokenHash).not.toBe(result.ok ? result.lobbyToken : '')`, which
    // on the FAILURE path reduces to `expect(false).not.toBe('')` — trivially true, so a claim
    // that started failing would have gone on passing. A narrowing guard makes the failure path
    // a test failure instead of a silent skip.
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected the claim to succeed');

    const call = mockGuestClaimLobbyPlace.mock.calls[0]?.[0] as { tokenHash: string };
    expect(call.tokenHash).toHaveLength(64);
    // The hash is not the token…
    expect(call.tokenHash).not.toBe(result.lobbyToken);
    // …and the token does not APPEAR anywhere in what the repository was handed. This is the
    // assertion that would catch a "helpful" future field carrying the raw secret across the
    // seam, which a bare inequality cannot.
    expect(JSON.stringify(mockGuestClaimLobbyPlace.mock.calls[0]?.[0])).not.toContain(
      result.lobbyToken
    );
  });
});

describe('⚠⚠ claimLobbyPlace — EVERY failure is `meeting_not_found` (the anonymity property)', () => {
  it('an unknown meeting', async () => {
    mockMeetingFindById.mockResolvedValue(undefined);

    await expect(
      claimLobbyPlace({ meetingId: MEETING_ID, name: 'Sam', email: 'sam@x.example' })
    ).resolves.toEqual({ ok: false, code: 'meeting_not_found' });
  });

  it.each(['ended', 'cancelled'] as const)(
    '⚠ a `%s` meeting — NOT `meeting_not_open_for_join`, which a MEMBER would get',
    async (status) => {
      // THIS IS THE PROPERTY. The caller is anonymous and holding a uuid they may have
      // guessed, so distinguishing "cancelled" from "no such meeting" is an existence oracle
      // over every meeting on the platform.
      mockMeetingFindById.mockResolvedValue(meetingRow({ status }));

      await expect(
        claimLobbyPlace({ meetingId: MEETING_ID, name: 'Sam', email: 'sam@x.example' })
      ).resolves.toEqual({ ok: false, code: 'meeting_not_found' });
    }
  );

  it('a cancelled-engagement meeting', async () => {
    mockEngagementFindById.mockResolvedValue({ id: ENGAGEMENT_ID, status: 'cancelled' });

    await expect(
      claimLobbyPlace({ meetingId: MEETING_ID, name: 'Sam', email: 'sam@x.example' })
    ).resolves.toEqual({ ok: false, code: 'meeting_not_found' });
  });

  it('an admin-only meeting (no primary context)', async () => {
    mockListByMeeting.mockResolvedValue([{ contextType: 'admin', contextId: null }]);

    await expect(
      claimLobbyPlace({ meetingId: MEETING_ID, name: 'Sam', email: 'sam@x.example' })
    ).resolves.toEqual({ ok: false, code: 'meeting_not_found' });
  });

  it('the participant CAP is reached — a link-share flood cannot fill a room', async () => {
    // 8 SEAT-HOLDING guests + 2 reserved base participants = the cap of 10.
    mockGuestCountLiveByMeeting.mockResolvedValue(8);

    await expect(
      claimLobbyPlace({ meetingId: MEETING_ID, name: 'Sam', email: 'sam@x.example' })
    ).resolves.toEqual({ ok: false, code: 'meeting_not_found' });
    expect(mockGuestClaimLobbyPlace).not.toHaveBeenCalled();
  });

  it('the QUEUE cap is reached — bounded separately from seats', async () => {
    // ⚠ MAX_LOBBY_QUEUE. Exceeding it refuses further KNOCKS and nothing else.
    mockGuestCountPendingLobbyKnocks.mockResolvedValue(MAX_LOBBY_QUEUE);

    await expect(
      claimLobbyPlace({ meetingId: MEETING_ID, name: 'Sam', email: 'sam@x.example' })
    ).resolves.toEqual({ ok: false, code: 'meeting_not_found' });
    expect(mockGuestClaimLobbyPlace).not.toHaveBeenCalled();
  });

  it('⚠⚠ a FULL QUEUE does NOT consume seats — the host can still invite by email', async () => {
    // The whole point of splitting the counters. Under the old single counter, 8 anonymous
    // knocks filled the meeting and the HOST could no longer invite anybody — and denying them
    // did not help, because a denied row still counted.
    mockGuestCountPendingLobbyKnocks.mockResolvedValue(MAX_LOBBY_QUEUE);
    mockGuestCountLiveByMeeting.mockResolvedValue(0);

    await claimLobbyPlace({ meetingId: MEETING_ID, name: 'Sam', email: 'sam@x.example' });

    // The SEAT counter — the one `inviteGuests` shares — was never moved by the queue.
    expect(mockGuestCountLiveByMeeting).toHaveBeenCalledWith(MEETING_ID);
    expect(mockGuestCountPendingLobbyKnocks).toHaveBeenCalledWith(MEETING_ID);
  });

  it('⚠⚠ a LIVE incumbent row in ANY admission state — a stranger cannot rotate a token away', async () => {
    // `ON CONFLICT DO NOTHING`, so the incumbent row is left BYTE-IDENTICAL and this returns
    // `undefined`. `pending`, `admitted`, `pre_admitted` AND `denied` all land on ONE literal —
    // a narrowing: the earlier compare-and-set answered `201` for a live `pending` incumbent and
    // `404` for the rest, i.e. it told the caller which one it was.
    mockGuestClaimLobbyPlace.mockResolvedValue(undefined);

    await expect(
      claimLobbyPlace({ meetingId: MEETING_ID, name: 'Sam', email: 'sam@x.example' })
    ).resolves.toEqual({ ok: false, code: 'meeting_not_found' });
  });

  it('produces a BYTE-IDENTICAL result for every one of those shapes', async () => {
    const shapes: Array<() => void> = [
      () => mockMeetingFindById.mockResolvedValue(undefined),
      () => mockMeetingFindById.mockResolvedValue(meetingRow({ status: 'cancelled' })),
      () => mockListByMeeting.mockResolvedValue([{ contextType: 'admin', contextId: null }]),
      () => mockGuestCountLiveByMeeting.mockResolvedValue(8),
      () => mockGuestCountPendingLobbyKnocks.mockResolvedValue(MAX_LOBBY_QUEUE),
      () => mockGuestClaimLobbyPlace.mockResolvedValue(undefined),
    ];

    const rendered = new Set<string>();
    for (const apply of shapes) {
      vi.clearAllMocks();
      mockMeetingFindById.mockResolvedValue(meetingRow());
      mockListByMeeting.mockResolvedValue([{ contextType: 'case', contextId: ENGAGEMENT_ID }]);
      mockEngagementFindById.mockResolvedValue({ id: ENGAGEMENT_ID, status: 'active' });
      mockGuestCountLiveByMeeting.mockResolvedValue(0);
      mockGuestCountPendingLobbyKnocks.mockResolvedValue(0);
      mockGuestClaimLobbyPlace.mockResolvedValue({ id: GUEST_ID });
      apply();
      rendered.add(
        JSON.stringify(
          await claimLobbyPlace({ meetingId: MEETING_ID, name: 'Sam', email: 'sam@x.example' })
        )
      );
    }

    // ⚠ NON-VACUITY: every shape really was exercised, so a `shapes` array someone empties
    // cannot make `size === 1` pass for free.
    expect(shapes).toHaveLength(6);
    // ONE distinct response across every failure shape…
    expect(rendered.size).toBe(1);
    // ⚠⚠ …AND IT IS **THIS** ONE. `size === 1` alone says only that the six agree — they would
    // agree just as well on `meeting_not_open_for_join`, or on a collapse onto some future
    // literal that leaks more. Asserting the exact payload is what makes this a test of the
    // anonymity property rather than of internal consistency.
    expect([...rendered]).toEqual([JSON.stringify({ ok: false, code: 'meeting_not_found' })]);
  });
});
