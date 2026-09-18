import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockMeetingFindById,
  mockListByMeeting,
  mockFindLivePendingLobbyByEmail,
  mockRotatePendingLobbyToken,
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

const SCHEDULED_START = new Date('2026-09-01T10:00:00.000Z');
const SCHEDULED_END = new Date('2026-09-01T11:00:00.000Z');
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

const PENDING_LOBBY_MATCH = {
  id: GUEST_ID,
  meetingId: MEETING_ID,
  email: CANONICAL_EMAIL,
  name: 'Dana Okoro',
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

  it('⚠ ENDED meeting → MATCH, a link IS sent (NOT assertMeetingJoinable)', async () => {
    mockMeetingFindById.mockResolvedValue(meetingRow({ status: 'ended' }));

    await request();

    expect(publishedPayloads('meeting.guest_reentry_link_sent')).toHaveLength(1);
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
