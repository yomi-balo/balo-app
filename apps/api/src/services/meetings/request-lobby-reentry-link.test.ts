import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockMeetingFindById,
  mockListByMeeting,
  mockFindLivePendingLobbyByEmail,
  mockRotatePendingLobbyToken,
  mockEngagementFindById,
  mockMintGuestInviteToken,
  mockPublish,
  mockTrackServer,
  mockAuthorizeMeetingParticipation,
  mockHasEngagementCapability,
  mockPublishGuestAddedCalendarInvites,
  mockCaseFindByEngagementId,
  mockProjectRequestFindById,
  mockRelationshipFindById,
  mockLogInfo,
  mockLogWarn,
  mockLogError,
} = vi.hoisted(() => ({
  mockMeetingFindById: vi.fn(),
  mockListByMeeting: vi.fn(),
  mockFindLivePendingLobbyByEmail: vi.fn(),
  mockRotatePendingLobbyToken: vi.fn(),
  mockEngagementFindById: vi.fn(),
  mockMintGuestInviteToken: vi.fn(),
  mockPublish: vi.fn(),
  mockTrackServer: vi.fn(),
  mockAuthorizeMeetingParticipation: vi.fn(),
  mockHasEngagementCapability: vi.fn(),
  mockPublishGuestAddedCalendarInvites: vi.fn(),
  mockCaseFindByEngagementId: vi.fn(),
  mockProjectRequestFindById: vi.fn(),
  mockRelationshipFindById: vi.fn(),
  mockLogInfo: vi.fn(),
  mockLogWarn: vi.fn(),
  mockLogError: vi.fn(),
}));

// ⚠ THE FACTORY MUST NAME EVERY EXPORT THE IMPORT GRAPH TOUCHES. `request-lobby-reentry-link.ts`
// imports `formatExpiryDate` / `resolveMeetingTitle` / `publishBestEffort` from the REAL
// `guest-participation.js` (not mocked — this pins that this service reuses that swallow
// rather than a copy), so every repository THAT FILE'S OWN imports touch must be named here too.
vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: mockLogInfo,
    warn: mockLogWarn,
    error: mockLogError,
  }),
}));
vi.mock('@balo/db', () => ({
  meetingsRepository: { findById: mockMeetingFindById },
  meetingContextsRepository: { listByMeeting: mockListByMeeting },
  meetingGuestsRepository: {
    findLivePendingLobbyByEmail: mockFindLivePendingLobbyByEmail,
    rotatePendingLobbyToken: mockRotatePendingLobbyToken,
  },
  agenciesRepository: { getSummaryById: vi.fn() },
  // ⚠ fix round (R-0) — the service now runs the REAL `assertMeetingJoinable`, which reads this
  // for every engagement-grain context type. `meeting-liveness.js` is DELIBERATELY NOT MOCKED:
  // the whole point of R-0 is that this arm uses the same gate `claimLobbyPlace` does, so
  // stubbing it out would leave the fix unasserted.
  engagementsRepository: { findById: mockEngagementFindById },
  caseEngagementsRepository: { findByEngagementId: mockCaseFindByEngagementId },
  companiesRepository: { findById: vi.fn() },
  expertsRepository: { findProfileById: vi.fn() },
  partyDomainsRepository: { listByParty: vi.fn() },
  partyMembershipsRepository: { listAdminUserIds: vi.fn() },
  projectRequestsRepository: { findById: mockProjectRequestFindById },
  requestExpertRelationshipsRepository: { findById: mockRelationshipFindById },
  usersRepository: { findById: vi.fn() },
}));
vi.mock('@balo/analytics/server', () => ({
  trackServer: mockTrackServer,
  GUEST_SERVER_EVENTS: {
    GUEST_REENTRY_REQUESTED: 'guest_reentry_requested',
  },
}));
vi.mock('../../notifications/index.js', () => ({
  notificationEvents: { publish: mockPublish },
}));
vi.mock('../../lib/guest-token.js', () => ({
  mintGuestInviteToken: mockMintGuestInviteToken,
}));
vi.mock('./authorize-meeting-participation.js', () => ({
  authorizeMeetingParticipation: mockAuthorizeMeetingParticipation,
}));
vi.mock('./authorize-engagement-host.js', () => ({
  hasEngagementCapability: mockHasEngagementCapability,
}));
vi.mock('../calendar-invites/publish-calendar-invites.js', () => ({
  publishGuestAddedCalendarInvites: mockPublishGuestAddedCalendarInvites,
}));
// ⚠ `@balo/shared/meetings` is DELIBERATELY NOT MOCKED — `selectPrimaryMeetingContext` and
// `GUEST_TOKEN_TTL_AFTER_END_MS` are what the assertions below are actually about.

import { requestLobbyReentryLink } from './request-lobby-reentry-link.js';

const MEETING_ID = '22222222-2222-4222-8222-222222222222';
const ENGAGEMENT_ID = '44444444-4444-4444-8444-444444444444';
const GUEST_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/**
 * ⚠⚠ RELATIVE TO `Date.now()`, NEVER A HARDCODED CALENDAR DATE. `assertMeetingJoinable` (wired
 * in by R-0) refuses any meeting whose `scheduled_end + 24h` has passed, so a fixed 2026-09-01
 * fixture would compile, pass on the day it was written, and then turn every MATCH test in this
 * file red on a later calendar day with no code change at all.
 */
const SCHEDULED_START = new Date(Date.now() - 10 * 60 * 1000);
const SCHEDULED_END = new Date(Date.now() + 50 * 60 * 1000);
const GUEST_TOKEN_TTL_AFTER_END_MS = 7 * 24 * 60 * 60 * 1000;

const CANONICAL_EMAIL = 'dana@northwind.test';

function meetingRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: MEETING_ID,
    status: 'scheduled',
    scheduledStart: SCHEDULED_START,
    scheduledEnd: SCHEDULED_END,
    ...overrides,
  };
}

const VERSION_TOKEN = '2026-09-18 21:04:05.123456+00';

const PENDING_LOBBY_MATCH = {
  id: GUEST_ID,
  meetingId: MEETING_ID,
  email: CANONICAL_EMAIL,
  name: 'Dana Okoro',
  // ⚠ fix round (R-6) — the opaque compare-and-set token the read projects and the write
  // demands. A plain literal here: the service must forward it UNMODIFIED, never parse it.
  versionToken: VERSION_TOKEN,
};

function rotatedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: GUEST_ID,
    meetingId: MEETING_ID,
    email: CANONICAL_EMAIL,
    name: 'Dana Okoro',
    expiresAt: new Date(SCHEDULED_END.getTime() + GUEST_TOKEN_TTL_AFTER_END_MS),
    ...overrides,
  };
}

/** A deterministic mint: the Nth call yields the Nth token pair. */
let mintCount = 0;
function nextMint(): { rawToken: string; tokenHash: string } {
  mintCount += 1;
  return { rawToken: `raw-token-${mintCount}`, tokenHash: `abcdef0123456789digest${mintCount}` };
}

/** The payload of the Nth `notificationEvents.publish` call for a given event key. */
function publishedPayloads(event: string): Record<string, unknown>[] {
  return mockPublish.mock.calls
    .filter((call) => call[0] === event)
    .map((call) => call[1] as Record<string, unknown>);
}

function request(overrides: Partial<{ meetingId: string; email: string }> = {}) {
  return requestLobbyReentryLink({
    meetingId: MEETING_ID,
    email: CANONICAL_EMAIL,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mintCount = 0;

  mockMeetingFindById.mockResolvedValue(meetingRow());
  mockListByMeeting.mockResolvedValue([{ contextType: 'case', contextId: ENGAGEMENT_ID }]);
  mockFindLivePendingLobbyByEmail.mockResolvedValue(PENDING_LOBBY_MATCH);
  mockRotatePendingLobbyToken.mockResolvedValue(rotatedRow());
  // ⚠ R-0 — an ACTIVE engagement, so the shared liveness gate passes on the happy path.
  mockEngagementFindById.mockResolvedValue({ id: ENGAGEMENT_ID, status: 'active' });
  mockMintGuestInviteToken.mockImplementation(nextMint);
  mockPublish.mockResolvedValue(undefined);
  mockCaseFindByEngagementId.mockResolvedValue({ title: 'CPQ implementation' });
});

describe('requestLobbyReentryLink — MATCH', () => {
  it('⚠⚠ publishes exactly once, with correlationId === tokenHash.slice(0, 16), derived from the mint', async () => {
    await request();

    const payloads = publishedPayloads('meeting.guest_reentry_link_sent');
    expect(payloads).toHaveLength(1);
    const [payload] = payloads;
    // ⚠ fix-round (F9) — READ FROM THE MOCK'S OWN RESULT, never a re-typed literal. A
    // hardcoded `'abcdef0123456789digest1'` only proves the test author copied the fixture
    // correctly; it would still pass if the service silently switched to a DIFFERENT source
    // for `correlationId` that happened to collide with that literal. Reading
    // `mock.results[0].value` ties the assertion to what the mint actually returned.
    const mintResult = mockMintGuestInviteToken.mock.results[0]?.value as
      | { tokenHash: string }
      | undefined;
    expect(mintResult).toBeDefined();
    // Derived from the mocked mint's OWN output — never hardcoded — so this fails if the
    // service switches to the guest row id (the dedup-swallow hazard).
    expect(payload?.correlationId).toBe(mintResult?.tokenHash.slice(0, 16));
  });

  it('the publish payload key set is EXACTLY the documented nine fields', async () => {
    await request();

    const [payload] = publishedPayloads('meeting.guest_reentry_link_sent');
    expect(Object.keys(payload ?? {}).sort((a, b) => a.localeCompare(b))).toEqual([
      'correlationId',
      'expiresOn',
      'guestName',
      'joinToken',
      'meetingId',
      'meetingTitle',
      'recipientEmail',
      'scheduledEndIso',
      'scheduledStartIso',
    ]);
  });

  it('⚠⚠ recipientEmail is the STORED row email, never input.email', async () => {
    mockRotatePendingLobbyToken.mockResolvedValue(
      rotatedRow({ email: 'stored@different-address.test' })
    );

    await request({ email: 'typed@another-address.test' });

    const [payload] = publishedPayloads('meeting.guest_reentry_link_sent');
    expect(payload?.recipientEmail).toBe('stored@different-address.test');
  });

  it('joinUrl is NOT built here — the payload carries meetingId and joinToken separately', async () => {
    await request();

    const [payload] = publishedPayloads('meeting.guest_reentry_link_sent');
    expect(payload).not.toHaveProperty('joinUrl');
    expect(payload?.meetingId).toBe(MEETING_ID);
    expect(payload?.joinToken).toBe('raw-token-1');
  });

  it('⚠⚠ tracks exactly {matched: true, distinct_id: guest.id}', async () => {
    await request();

    expect(mockTrackServer).toHaveBeenCalledWith('guest_reentry_requested', {
      matched: true,
      distinct_id: GUEST_ID,
    });
    const [, properties] = mockTrackServer.mock.calls[0] as [string, Record<string, unknown>];
    expect(Object.keys(properties).sort((a, b) => a.localeCompare(b))).toEqual([
      'distinct_id',
      'matched',
    ]);
  });

  it('the structured log carries meetingId and carries neither the email nor the token', async () => {
    await request();

    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: MEETING_ID, matched: true }),
      expect.any(String)
    );
    const serialised = JSON.stringify(mockLogInfo.mock.calls);
    expect(serialised).not.toContain(CANONICAL_EMAIL);
    expect(serialised).not.toContain('raw-token-1');
  });

  it('⚠⚠ ORDER: rotatePendingLobbyToken resolves BEFORE publish is called', async () => {
    await request();

    const [rotateOrder] = mockRotatePendingLobbyToken.mock.invocationCallOrder;
    const [publishOrder] = mockPublish.mock.invocationCallOrder;
    if (rotateOrder === undefined || publishOrder === undefined) {
      throw new Error('expected both rotatePendingLobbyToken and publish to have been called');
    }
    expect(rotateOrder).toBeLessThan(publishOrder);
  });

  it('⚠ expiresAt passed to the rotate is derived from the MEETING, never Date.now()', async () => {
    await request();

    expect(mockRotatePendingLobbyToken).toHaveBeenCalledWith(
      expect.objectContaining({
        meetingId: MEETING_ID,
        guestId: GUEST_ID,
        expiresAt: new Date(SCHEDULED_END.getTime() + GUEST_TOKEN_TTL_AFTER_END_MS),
      })
    );
  });

  /**
   * BAL-442 fix round (R-6) — the compare-and-set token the READ projected must reach the WRITE
   * UNCHANGED. If the service ever re-derived it (or dropped it), two simultaneous recoveries
   * would both rotate again and the loser's email could arrive last holding a dead credential.
   */
  it('⚠⚠ R-6 — forwards the READ row`s versionToken to the rotation, byte for byte', async () => {
    mockFindLivePendingLobbyByEmail.mockResolvedValue({
      ...PENDING_LOBBY_MATCH,
      versionToken: 'a-different-opaque-token',
    });

    await request();

    expect(mockRotatePendingLobbyToken).toHaveBeenCalledWith(
      expect.objectContaining({ expectedVersionToken: 'a-different-opaque-token' })
    );
  });

  it('⚠⚠ the RAW token never reaches the repository — only the hash does', async () => {
    await request();

    expect(JSON.stringify(mockRotatePendingLobbyToken.mock.calls)).not.toContain('raw-token-1');
  });

  it('publish throwing still resolves the function, and log.error fires once (publishBestEffort reuse)', async () => {
    mockPublish.mockRejectedValue(new Error('Redis unavailable'));

    await expect(request()).resolves.toBeUndefined();
    expect(mockLogError).toHaveBeenCalledTimes(1);
  });

  it('omits guestName when the rotated row has no name', async () => {
    mockRotatePendingLobbyToken.mockResolvedValue(rotatedRow({ name: null }));

    await request();

    const [payload] = publishedPayloads('meeting.guest_reentry_link_sent');
    expect(payload === undefined ? true : 'guestName' in payload).toBe(false);
  });
});

describe('requestLobbyReentryLink — MISS', () => {
  it('no live pending row → miss, no publish, matched: false with the anonymous constant', async () => {
    mockFindLivePendingLobbyByEmail.mockResolvedValue(undefined);

    await request();

    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockTrackServer).toHaveBeenCalledWith('guest_reentry_requested', {
      matched: false,
      distinct_id: 'system:guest-reentry',
    });
  });

  it('⚠ the miss-arm distinct_id equals the IMPORTED constant, not a re-typed literal', async () => {
    const { GUEST_REENTRY_ANONYMOUS_DISTINCT_ID } = await import('./request-lobby-reentry-link.js');
    mockFindLivePendingLobbyByEmail.mockResolvedValue(undefined);

    await request();

    expect(mockTrackServer).toHaveBeenCalledWith(
      'guest_reentry_requested',
      expect.objectContaining({ distinct_id: GUEST_REENTRY_ANONYMOUS_DISTINCT_ID })
    );
  });

  it('SOFT-DELETED / nonexistent meeting (findById → undefined) → miss', async () => {
    mockMeetingFindById.mockResolvedValue(undefined);

    await request();

    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockFindLivePendingLobbyByEmail).not.toHaveBeenCalled();
    expect(mockTrackServer).toHaveBeenCalledWith(
      'guest_reentry_requested',
      expect.objectContaining({ matched: false })
    );
  });

  it('CANCELLED meeting → miss, no publish', async () => {
    mockMeetingFindById.mockResolvedValue(meetingRow({ status: 'cancelled' }));

    await request();

    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockFindLivePendingLobbyByEmail).not.toHaveBeenCalled();
  });

  it('unresolvable primary context (none) → miss', async () => {
    mockListByMeeting.mockResolvedValue([]);

    await request();

    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockFindLivePendingLobbyByEmail).not.toHaveBeenCalled();
  });

  it('ambiguous primary context → miss', async () => {
    // Two DISTINCT contexts at the SAME top precedence tier — `selectPrimaryMeetingContext`
    // refuses to pick one arbitrarily. A `case` alongside a `project_discovery` would NOT be
    // ambiguous (different precedence tiers), so this uses two `case` contexts.
    mockListByMeeting.mockResolvedValue([
      { contextType: 'case', contextId: 'case-a' },
      { contextType: 'case', contextId: 'case-b' },
    ]);

    await request();

    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockFindLivePendingLobbyByEmail).not.toHaveBeenCalled();
  });

  it('⚠⚠ rotation returns undefined (lost race) → no publish, matched: false', async () => {
    mockRotatePendingLobbyToken.mockResolvedValue(undefined);

    await request();

    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockTrackServer).toHaveBeenCalledWith('guest_reentry_requested', {
      matched: false,
      distinct_id: 'system:guest-reentry',
    });
  });

  it('the structured log on a miss carries meetingId and never the email', async () => {
    mockFindLivePendingLobbyByEmail.mockResolvedValue(undefined);

    await request();

    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: MEETING_ID, matched: false }),
      expect.any(String)
    );
    expect(JSON.stringify(mockLogInfo.mock.calls)).not.toContain(CANONICAL_EMAIL);
  });
});

/**
 * BAL-442 fix round (R-0) — THE LIVENESS GATE, AND THE TEST THAT USED TO ASSERT THE OPPOSITE.
 *
 * This file previously carried "⚠ ENDED meeting → MATCH, a link IS sent (NOT
 * assertMeetingJoinable)". That assertion was WRONG, not merely over-permissive: a lobby token
 * on an ended meeting is refused by `joinMeetingAsGuest`'s own `assertMeetingJoinable` call
 * BEFORE its admission switch, and `resolveGuestRecapAccess` refuses a PENDING row too — so the
 * "recovered" credential could do nothing at all, while the rotation had already killed
 * whatever the guest still held. The service now runs the SAME gate `claimLobbyPlace` runs, and
 * a failure is a NEUTRAL MISS: no publish, `matched: false`, the anonymous `distinct_id`.
 *
 * ⚠ `meeting-liveness.js` IS NOT MOCKED IN THIS FILE — these cases drive the real predicate.
 */
describe('requestLobbyReentryLink — R-0: the shared liveness gate, every failure a NEUTRAL MISS', () => {
  /** The three assertions "a neutral miss" has to mean, applied identically to every arm. */
  async function expectNeutralMiss(): Promise<void> {
    await request();

    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockRotatePendingLobbyToken).not.toHaveBeenCalled();
    expect(mockTrackServer).toHaveBeenCalledWith('guest_reentry_requested', {
      matched: false,
      distinct_id: 'system:guest-reentry',
    });
  }

  it('⚠⚠ FLIPPED — an ENDED meeting is a MISS and NOTHING is sent', async () => {
    mockMeetingFindById.mockResolvedValue(meetingRow({ status: 'ended' }));

    await expectNeutralMiss();
    // ⚠ THE POSITIVE HALF: the email was not merely un-asserted, it was never published.
    expect(publishedPayloads('meeting.guest_reentry_link_sent')).toHaveLength(0);
  });

  it('a CANCELLED meeting is a MISS (the same terminal set, through the shared gate)', async () => {
    mockMeetingFindById.mockResolvedValue(meetingRow({ status: 'cancelled' }));

    await expectNeutralMiss();
  });

  /**
   * ⚠⚠ THE MOVED-EARLIER HAZARD (Qodo #4). The stored `expires_at` can still be in the future
   * while the RECOMPUTED `scheduled_end + TTL` is already past, so without this gate the
   * rotation destroyed a WORKING link and emailed a dead one.
   */
  it('⚠⚠ a meeting whose TOKEN WINDOW has elapsed is a MISS — the recomputed expiry is dead', async () => {
    const longPast = new Date(Date.now() - 48 * 60 * 60 * 1000);
    mockMeetingFindById.mockResolvedValue(
      meetingRow({ scheduledStart: longPast, scheduledEnd: longPast })
    );

    await expectNeutralMiss();
  });

  it('a CANCELLED engagement behind an otherwise-live meeting is a MISS', async () => {
    mockEngagementFindById.mockResolvedValue({ id: ENGAGEMENT_ID, status: 'cancelled' });

    await expectNeutralMiss();
  });

  it('a MISSING (or soft-deleted) engagement is a MISS', async () => {
    mockEngagementFindById.mockResolvedValue(undefined);

    await expectNeutralMiss();
  });

  /**
   * ⚠ THE REQUEST-GRAIN CONTEXTS HAVE NO ENGAGEMENT TO READ, so the gate must NOT deny them —
   * the negative pair for the cases above, without which "deny everything" would pass them all.
   */
  it('⚠ a request-grain context (project_discovery) still MATCHES — no engagement is read', async () => {
    mockListByMeeting.mockResolvedValue([
      { contextType: 'project_discovery', contextId: '55555555-5555-4555-8555-555555555555' },
    ]);

    await request();

    expect(publishedPayloads('meeting.guest_reentry_link_sent')).toHaveLength(1);
    expect(mockEngagementFindById).not.toHaveBeenCalled();
  });
});

/**
 * BAL-442 fix round (R-5) — `publishBestEffort` SWALLOWS a queueing failure, and this arm used
 * to report `matched: true` and log "link sent" straight through it. That contradicted the
 * event's own documented meaning ("A FRESH LINK WAS EMAILED") and hid the single worst outcome
 * this feature has: the rotation is committed, so the guest's old link is DEAD, and nothing
 * replaced it.
 *
 * ⚠⚠ IT CHANGES ONLY WHAT IS REPORTED. The function still returns `void`, so no verdict crosses
 * the boundary and neither the status, the body nor the floor can move.
 */
describe('requestLobbyReentryLink — R-5: a swallowed publish is NOT a match', () => {
  beforeEach(() => {
    mockPublish.mockRejectedValue(new Error('Redis unavailable'));
  });

  it('⚠⚠ tracks {matched: false, distinct_id: the anonymous constant} when the publish is swallowed', async () => {
    await request();

    expect(mockTrackServer).toHaveBeenCalledWith('guest_reentry_requested', {
      matched: false,
      distinct_id: 'system:guest-reentry',
    });
    // ⚠ THE NEGATIVE HALF — the success shape must appear NOWHERE in the call log.
    expect(mockTrackServer).not.toHaveBeenCalledWith(
      'guest_reentry_requested',
      expect.objectContaining({ matched: true })
    );
  });

  it('⚠⚠ warns that the credential is dead and nothing replaced it — and does NOT log a send', async () => {
    await request();

    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: MEETING_ID, guestId: GUEST_ID, matched: false }),
      'Lobby re-entry link was NOT queued — the previous credential is dead and nothing replaced it'
    );
    // ⚠ NO `log.info` MAY CLAIM A SEND. The whole defect was a success line over a failure.
    const infoLines = mockLogInfo.mock.calls.map((call) => String(call[1]));
    expect(infoLines).toHaveLength(0);
  });

  it('⚠ the rotation still HAPPENED — the credential really is dead, which is why the warn matters', async () => {
    await request();

    expect(mockRotatePendingLobbyToken).toHaveBeenCalledTimes(1);
  });

  it('⚠ no address, no raw token and no hash in any log line', async () => {
    await request();

    const serialised = JSON.stringify([
      ...mockLogWarn.mock.calls,
      ...mockLogInfo.mock.calls,
      ...mockLogError.mock.calls,
    ]);
    expect(serialised).not.toContain(CANONICAL_EMAIL);
    expect(serialised).not.toContain('raw-token-1');
  });

  it('⚠ the SUCCESS path still reports matched: true — the negative pair for the four above', async () => {
    mockPublish.mockResolvedValue(undefined);

    await request();

    expect(mockTrackServer).toHaveBeenCalledWith('guest_reentry_requested', {
      matched: true,
      distinct_id: GUEST_ID,
    });
    expect(mockLogWarn).not.toHaveBeenCalled();
  });
});
