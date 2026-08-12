import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAuthorizeMeetingParticipation,
  mockHasEngagementCapability,
  mockMintGuestInviteToken,
  mockPublish,
  mockTrackServer,
  mockCreateMany,
  mockCountLiveByMeeting,
  mockListLiveByMeeting,
  mockFindLiveById,
  mockRevoke,
  mockDecideAdmission,
  mockListDomainsByParty,
  mockListAdminUserIds,
  mockUserFindById,
  mockCompanyFindById,
  mockExpertFindProfileById,
  mockAgencyGetSummaryById,
  mockCaseFindByEngagementId,
  mockProjectRequestFindById,
  mockRelationshipFindById,
} = vi.hoisted(() => ({
  mockAuthorizeMeetingParticipation: vi.fn(),
  mockHasEngagementCapability: vi.fn(),
  mockMintGuestInviteToken: vi.fn(),
  mockPublish: vi.fn(),
  mockTrackServer: vi.fn(),
  mockCreateMany: vi.fn(),
  mockCountLiveByMeeting: vi.fn(),
  mockListLiveByMeeting: vi.fn(),
  mockFindLiveById: vi.fn(),
  mockRevoke: vi.fn(),
  mockDecideAdmission: vi.fn(),
  mockListDomainsByParty: vi.fn(),
  mockListAdminUserIds: vi.fn(),
  mockUserFindById: vi.fn(),
  mockCompanyFindById: vi.fn(),
  mockExpertFindProfileById: vi.fn(),
  mockAgencyGetSummaryById: vi.fn(),
  mockCaseFindByEngagementId: vi.fn(),
  mockProjectRequestFindById: vi.fn(),
  mockRelationshipFindById: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  agenciesRepository: { getSummaryById: mockAgencyGetSummaryById },
  caseEngagementsRepository: { findByEngagementId: mockCaseFindByEngagementId },
  companiesRepository: { findById: mockCompanyFindById },
  expertsRepository: { findProfileById: mockExpertFindProfileById },
  meetingGuestsRepository: {
    createMany: mockCreateMany,
    countLiveByMeeting: mockCountLiveByMeeting,
    listLiveByMeeting: mockListLiveByMeeting,
    findLiveById: mockFindLiveById,
    revoke: mockRevoke,
    decideAdmission: mockDecideAdmission,
  },
  partyDomainsRepository: { listByParty: mockListDomainsByParty },
  partyMembershipsRepository: { listAdminUserIds: mockListAdminUserIds },
  projectRequestsRepository: { findById: mockProjectRequestFindById },
  requestExpertRelationshipsRepository: { findById: mockRelationshipFindById },
  usersRepository: { findById: mockUserFindById },
}));
vi.mock('@balo/analytics/server', () => ({
  trackServer: mockTrackServer,
  // ⚠ A HAND-ROLLED LITERAL, SO IT MUST LIST EVERY KEY THE SOURCE DECLARES. An omitted key
  // yields `undefined` as the EVENT NAME at runtime with NO type error — the event simply
  // vanishes from PostHog. `GUEST_JOINED` was added by BAL-132.
  GUEST_SERVER_EVENTS: {
    GUEST_ADMITTED: 'guest_admitted',
    GUEST_DENIED: 'guest_denied',
    GUEST_INVITE_OPENED: 'guest_invite_opened',
    GUEST_INVITED: 'guest_invited',
    GUEST_JOINED: 'guest_joined',
    GUEST_REMOVED: 'guest_removed',
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
/**
 * ⚠ `@balo/shared/meetings`, `@balo/shared/domains` AND `@balo/shared/authz` ARE DELIBERATELY
 * NOT MOCKED. The real `MAX_MEETING_PARTICIPANTS` / `RESERVED_BASE_PARTICIPANTS` are what
 * make the cap arithmetic below a test of the SHIPPED number; the real `projectGuestForViewer`
 * is the concealment rule under test on the list path; and the real `classifyEmailDomain` is
 * the whole of the load-bearing freemail exclusion in `resolveGuestAccessScope`. Stubbing any
 * of the three would leave the assertion asserting the stub.
 */

import {
  decideGuestAdmission,
  inviteGuests,
  listGuests,
  removeGuest,
  type InviteGuestInput,
} from './guest-participation.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────────────

const USER_ID = '11111111-1111-4111-8111-111111111111';
const MEETING_ID = '22222222-2222-4222-8222-222222222222';
const COMPANY_ID = '33333333-3333-4333-8333-333333333333';
const ENGAGEMENT_ID = '44444444-4444-4444-8444-444444444444';
const EXPERT_PROFILE_ID = '88888888-8888-4888-8888-888888888888';
const AGENCY_ID = '99999999-9999-4999-8999-999999999999';
const GUEST_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ADMIN_A = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const SCHEDULED_START = new Date('2026-09-01T10:00:00.000Z');
const SCHEDULED_END = new Date('2026-09-01T11:00:00.000Z');
const CREATED_AT = new Date('2026-08-10T09:00:00.000Z');

const CLIENT_SUBJECT = { contextType: 'case', contextId: ENGAGEMENT_ID } as const;

/** The exact shape `meetingGuestsRepository.createMany` is handed, so assertions can read it. */
interface PreparedGuest {
  email: string;
  name: string | null;
  emailDomain: string | null;
  party: 'client' | 'expert';
  participationRole: 'guest' | 'delegate';
  accessScope: 'meeting' | 'engagement';
  inviteChannel: 'email';
  admission: 'pre_admitted';
  tokenHash: string;
  expiresAt: Date;
}

interface CreateManyArgs {
  meetingId: string;
  invitedById: string;
  guests: PreparedGuest[];
}

function meetingRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: MEETING_ID,
    status: 'scheduled',
    scheduledStart: SCHEDULED_START,
    scheduledEnd: SCHEDULED_END,
    ...overrides,
  };
}

function gateOk(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    side: 'client',
    meeting: meetingRow(),
    subject: CLIENT_SUBJECT,
    companyId: COMPANY_ID,
    expertProfileId: EXPERT_PROFILE_ID,
    ...overrides,
  };
}

/** `createMany` echoes back exactly what the service prepared — the row IS the prepared guest. */
function committedRows(input: CreateManyArgs): Record<string, unknown>[] {
  return input.guests.map((guest, index) => ({
    id: `guest-${index}`,
    meetingId: input.meetingId,
    email: guest.email,
    name: guest.name,
    emailDomain: guest.emailDomain,
    party: guest.party,
    participationRole: guest.participationRole,
    accessScope: guest.accessScope,
    admission: guest.admission,
    invitedById: input.invitedById,
    expiresAt: guest.expiresAt,
    accessCount: 0,
    createdAt: CREATED_AT,
  }));
}

/** The arguments `createMany` was called with, narrowed for assertions. */
function createManyArgs(): CreateManyArgs {
  const [call] = mockCreateMany.mock.calls;
  if (call === undefined) throw new Error('createMany was never called');
  const [args] = call;
  return args as CreateManyArgs;
}

/** The single prepared guest of a one-guest batch. */
function onlyPreparedGuest(): PreparedGuest {
  const [guest] = createManyArgs().guests;
  if (guest === undefined) throw new Error('createMany was called with an empty batch');
  return guest;
}

/** The payload of the Nth `notificationEvents.publish` call for a given event key. */
function publishedPayloads(event: string): Record<string, unknown>[] {
  return mockPublish.mock.calls
    .filter((call) => call[0] === event)
    .map((call) => call[1] as Record<string, unknown>);
}

/** A one-guest invite request. `party` / `accessScope` are NOT expressible in this type. */
function invite(guests: InviteGuestInput[]): Parameters<typeof inviteGuests>[0] {
  return { meetingId: MEETING_ID, actorUserId: USER_ID, entryPoint: 'case_surface', guests };
}

/**
 * A deterministic mint: the Nth call yields the Nth token pair.
 *
 * ⚠ THE TWO HALVES SHARE NO SUBSTRING, DELIBERATELY. A fixture like
 * `hash-of-${rawToken}` would make "the repository never sees the raw secret" pass
 * vacuously — the hash would contain the raw token, so the assertion could not distinguish
 * a leak from the fixture's own naming.
 */
let mintCount = 0;
function nextMint(): { rawToken: string; tokenHash: string } {
  mintCount += 1;
  return { rawToken: `raw-token-${mintCount}`, tokenHash: `digest-${mintCount}` };
}

beforeEach(() => {
  vi.clearAllMocks();
  mintCount = 0;

  mockAuthorizeMeetingParticipation.mockResolvedValue(gateOk());
  mockHasEngagementCapability.mockResolvedValue(false);
  mockMintGuestInviteToken.mockImplementation(nextMint);
  mockPublish.mockResolvedValue(undefined);

  mockCountLiveByMeeting.mockResolvedValue(0);
  mockCreateMany.mockImplementation((input: CreateManyArgs) =>
    Promise.resolve(committedRows(input))
  );
  mockListLiveByMeeting.mockResolvedValue([]);
  mockFindLiveById.mockResolvedValue(undefined);
  mockRevoke.mockResolvedValue(undefined);
  mockDecideAdmission.mockResolvedValue(undefined);

  mockListDomainsByParty.mockResolvedValue([]);
  mockListAdminUserIds.mockResolvedValue([]);
  mockUserFindById.mockResolvedValue({ firstName: 'Priya', lastName: 'Nair' });
  mockCompanyFindById.mockResolvedValue({ name: 'Northwind Industrial' });
  mockExpertFindProfileById.mockResolvedValue({ agencyId: AGENCY_ID });
  mockAgencyGetSummaryById.mockResolvedValue({ name: 'CloudPeak' });
  mockCaseFindByEngagementId.mockResolvedValue({ title: 'CPQ implementation' });
  mockProjectRequestFindById.mockResolvedValue({ title: 'Field service rollout' });
  mockRelationshipFindById.mockResolvedValue({ projectRequestId: 'req-1' });
});

// ── inviteGuests — the ORDER of the writes ────────────────────────────────────────────

describe('inviteGuests — MINT BEFORE PUBLISH is a correctness constraint, not a style', () => {
  it('⚠ commits the rows BEFORE it publishes anything', async () => {
    // The raw join token exists only in memory. Publishing first would carry no credential;
    // publishing before a failed write would email a link to a guest that does not exist.
    await inviteGuests(invite([{ email: 'dana@northwind.example' }]));

    const [mintOrder] = mockMintGuestInviteToken.mock.invocationCallOrder;
    const [createOrder] = mockCreateMany.mock.invocationCallOrder;
    const [publishOrder] = mockPublish.mock.invocationCallOrder;

    // ⚠ REAL GUARDS, NOT `toBeDefined()` + `!`. Under `noUncheckedIndexedAccess` an index
    // read is `T | undefined`, and `expect(x).toBeDefined()` narrows nothing for the
    // compiler — so the `!`s that followed were load-bearing here and simultaneously
    // flagged by SonarCloud as "unnecessary non-null assertion" (it analyses WITHOUT that
    // flag). Throwing narrows for both readers, and fails just as loudly.
    if (mintOrder === undefined || createOrder === undefined || publishOrder === undefined) {
      throw new Error('expected mint, createMany and publish to have all been called');
    }
    expect(mintOrder).toBeLessThan(createOrder);
    expect(createOrder).toBeLessThan(publishOrder);
  });

  it('⚠ publishes NOTHING at all when the write throws', async () => {
    mockCreateMany.mockRejectedValue(Object.assign(new Error('duplicate'), { code: '23505' }));

    await inviteGuests(invite([{ email: 'dana@northwind.example' }]));

    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockTrackServer).not.toHaveBeenCalled();
  });

  it('⚠ hands the repository the HASH and the notification the RAW token — never the reverse', async () => {
    await inviteGuests(invite([{ email: 'dana@northwind.example' }]));

    expect(onlyPreparedGuest().tokenHash).toBe('digest-1');
    // The raw secret must never reach `@balo/db` — the Drizzle query-logging hook sees every
    // bind parameter.
    expect(JSON.stringify(createManyArgs())).not.toContain('raw-token-1');

    const [payload] = publishedPayloads('meeting.guest_invited');
    expect(payload?.joinToken).toBe('raw-token-1');
  });

  it('mints ONE token per deduplicated guest and pairs each with its own row', async () => {
    await inviteGuests(
      invite([{ email: 'dana@northwind.example' }, { email: 'sam@northwind.example' }])
    );

    expect(mockMintGuestInviteToken).toHaveBeenCalledTimes(2);
    const tokens = publishedPayloads('meeting.guest_invited').map((p) => p.joinToken);
    expect(tokens).toEqual(['raw-token-1', 'raw-token-2']);
    expect(new Set(tokens).size).toBe(2);
  });

  it('never publishes the raw token to the SAME-PARTY roster FYI', async () => {
    mockListAdminUserIds.mockResolvedValue([ADMIN_A]);

    await inviteGuests(invite([{ email: 'dana@northwind.example', name: 'Dana' }]));

    const [fyi] = publishedPayloads('meeting.guest_added');
    expect(fyi).toBeDefined();
    expect(JSON.stringify(fyi)).not.toContain('raw-token');
    // ⚠ NAME ONLY, never the address — the FYI goes to colleagues, not to the guest.
    expect(JSON.stringify(fyi)).not.toContain('dana@northwind.example');
    expect(fyi?.guestDisplayName).toBe('Dana');
    expect(fyi?.recipientUserIds).toEqual([ADMIN_A]);
  });

  it('falls back to the neutral noun in the FYI for a nameless guest', async () => {
    mockListAdminUserIds.mockResolvedValue([ADMIN_A]);

    await inviteGuests(invite([{ email: 'dana@northwind.example' }]));

    const [fyi] = publishedPayloads('meeting.guest_added');
    expect(fyi?.guestDisplayName).toBe('A guest');
  });

  it('EXCLUDES the acting inviter from the same-party FYI', async () => {
    mockListAdminUserIds.mockResolvedValue([USER_ID, ADMIN_A]);

    await inviteGuests(invite([{ email: 'dana@northwind.example' }]));

    const [fyi] = publishedPayloads('meeting.guest_added');
    expect(fyi?.recipientUserIds).toEqual([ADMIN_A]);
  });

  it('skips the FYI entirely when no same-party recipient remains', async () => {
    mockListAdminUserIds.mockResolvedValue([USER_ID]);

    await inviteGuests(invite([{ email: 'dana@northwind.example' }]));

    expect(publishedPayloads('meeting.guest_added')).toHaveLength(0);
  });
});

// ── inviteGuests — `party` and `accessScope` are SERVER-DERIVED ───────────────────────

describe('inviteGuests — `party` and `accessScope` come from the SERVER, never from the body', () => {
  /**
   * ⚠ NEITHER FIELD EXISTS ON `InviteGuestInput`, and the Zod schema has no key for either —
   * so a caller that sends them has them STRIPPED before this service ever runs. That is the
   * anti-cross-party control. These tests send them anyway (through a cast, exactly as a
   * hand-rolled HTTP client would) and assert the written row ignores both.
   */
  const HOSTILE_BODY = {
    email: 'dana@northwind.example',
    party: 'expert',
    accessScope: 'engagement',
    admission: 'admitted',
    inviteChannel: 'link',
  } as unknown as InviteGuestInput;

  it('⚠ writes the party from the GATE, not the `party` a caller smuggled in', async () => {
    mockAuthorizeMeetingParticipation.mockResolvedValue(gateOk({ side: 'client' }));

    await inviteGuests(invite([HOSTILE_BODY]));

    expect(onlyPreparedGuest().party).toBe('client');
  });

  it('⚠ writes the SERVER-COMPUTED accessScope, not the `engagement` a caller claimed', async () => {
    // No registered domain ⇒ the honest answer is the narrow `meeting`, whatever the body said.
    mockListDomainsByParty.mockResolvedValue([]);

    await inviteGuests(invite([HOSTILE_BODY]));

    expect(onlyPreparedGuest().accessScope).toBe('meeting');
  });

  it('ignores a smuggled `admission` and `inviteChannel` too — both are fixed by the path', async () => {
    await inviteGuests(invite([HOSTILE_BODY]));

    const guest = onlyPreparedGuest();
    expect(guest.admission).toBe('pre_admitted');
    expect(guest.inviteChannel).toBe('email');
  });

  it('flips the written party to `expert` when the GATE resolved the expert side', async () => {
    mockAuthorizeMeetingParticipation.mockResolvedValue(gateOk({ side: 'expert' }));

    await inviteGuests(invite([{ email: 'sam@cloudpeak.example' }]));

    expect(onlyPreparedGuest().party).toBe('expert');
  });

  it('stamps `invitedById` from the ACTOR, and scopes the write to the authorized meeting', async () => {
    await inviteGuests(invite([{ email: 'dana@northwind.example' }]));

    expect(mockCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: MEETING_ID, invitedById: USER_ID })
    );
  });

  it('derives `expiresAt` from the MEETING end, never from the mint instant', async () => {
    // 7 days past `scheduled_end` — which is why the column has no SQL default.
    await inviteGuests(invite([{ email: 'dana@northwind.example' }]));

    expect(onlyPreparedGuest().expiresAt).toEqual(
      new Date(SCHEDULED_END.getTime() + 7 * 24 * 60 * 60 * 1000)
    );
  });
});

// ── inviteGuests — the participant cap (D8) ──────────────────────────────────────────

describe('inviteGuests — the cap counts RESERVED_BASE_PARTICIPANTS + live guests + the batch', () => {
  it.each([
    { liveGuests: 0, requested: 1, label: '2 + 0 + 1 = 3' },
    { liveGuests: 3, requested: 4, label: '2 + 3 + 4 = 9' },
    { liveGuests: 7, requested: 1, label: '2 + 7 + 1 = 10 — EXACTLY at the cap' },
    { liveGuests: 0, requested: 8, label: '2 + 0 + 8 = 10 — a full batch into an empty meeting' },
  ])('succeeds at $label', async ({ liveGuests, requested }) => {
    mockCountLiveByMeeting.mockResolvedValue(liveGuests);

    const result = await inviteGuests(
      invite(
        Array.from({ length: requested }, (_, i) => ({ email: `guest${i}@northwind.example` }))
      )
    );

    expect(result.ok).toBe(true);
    expect(mockCreateMany).toHaveBeenCalledTimes(1);
  });

  it.each([
    { liveGuests: 8, requested: 1, label: '2 + 8 + 1 = 11' },
    { liveGuests: 7, requested: 2, label: '2 + 7 + 2 = 11' },
    { liveGuests: 0, requested: 9, label: '2 + 0 + 9 = 11 — the reserved seats are what tip it' },
    { liveGuests: 20, requested: 1, label: 'an already-overfull meeting' },
  ])(
    'refuses `participant_cap_reached` at $label, WITHOUT writing',
    async ({ liveGuests, requested }) => {
      mockCountLiveByMeeting.mockResolvedValue(liveGuests);

      const result = await inviteGuests(
        invite(
          Array.from({ length: requested }, (_, i) => ({ email: `guest${i}@northwind.example` }))
        )
      );

      expect(result).toEqual({ ok: false, code: 'participant_cap_reached' });
      expect(mockCreateMany).not.toHaveBeenCalled();
      expect(mockPublish).not.toHaveBeenCalled();
    }
  );

  it('reports the roster counts AFTER the write, so the composer re-renders "{n} of 10"', async () => {
    mockCountLiveByMeeting.mockResolvedValue(3);

    const result = await inviteGuests(
      invite([{ email: 'a@northwind.example' }, { email: 'b@northwind.example' }])
    );

    expect(result).toMatchObject({ ok: true, participantCount: 7, participantCap: 10 });
  });

  it('counts the live guests of THIS meeting only', async () => {
    await inviteGuests(invite([{ email: 'dana@northwind.example' }]));

    expect(mockCountLiveByMeeting).toHaveBeenCalledWith(MEETING_ID);
  });
});

// ── inviteGuests — dedupe runs BEFORE the cap ────────────────────────────────────────

describe('inviteGuests — case-insensitive dedupe, BEFORE the cap count', () => {
  const SAME_PERSON_THREE_WAYS: InviteGuestInput[] = [
    { email: 'Dana@x.example', name: 'Dana' },
    { email: 'dana@x.example', name: 'Dana Again' },
    { email: 'DANA@X.EXAMPLE', name: 'Dana Once More' },
  ];

  it('⚠ consumes ONE seat, not three — which is only true if dedupe precedes the count', async () => {
    // At 7 live guests the meeting has exactly one seat left. Counting the RAW array would
    // make this 2 + 7 + 3 = 12 and refuse; counting the deduplicated one makes it 10.
    mockCountLiveByMeeting.mockResolvedValue(7);

    const result = await inviteGuests(invite(SAME_PERSON_THREE_WAYS));

    expect(result).toMatchObject({ ok: true, participantCount: 10 });
  });

  it('writes ONE row, lowercased, keeping the FIRST occurrence’s name', async () => {
    await inviteGuests(invite(SAME_PERSON_THREE_WAYS));

    const { guests } = createManyArgs();
    expect(guests).toHaveLength(1);
    expect(guests[0]).toMatchObject({ email: 'dana@x.example', name: 'Dana' });
  });

  it('trims surrounding whitespace before comparing and before storing', async () => {
    await inviteGuests(invite([{ email: '  Dana@x.example  ' }, { email: 'dana@x.example' }]));

    const { guests } = createManyArgs();
    expect(guests).toHaveLength(1);
    expect(guests[0]?.email).toBe('dana@x.example');
  });

  it('trims a guest NAME, and stores null rather than an empty string', async () => {
    await inviteGuests(invite([{ email: 'dana@x.example', name: '  Dana  ' }]));

    expect(onlyPreparedGuest().name).toBe('Dana');
  });

  it('stores a null name when none was supplied', async () => {
    await inviteGuests(invite([{ email: 'dana@x.example' }]));

    expect(onlyPreparedGuest().name).toBeNull();
  });

  it('keeps genuinely distinct addresses distinct', async () => {
    await inviteGuests(
      invite([{ email: 'dana@x.example' }, { email: 'sam@x.example' }, { email: 'dana@y.example' }])
    );

    expect(createManyArgs().guests.map((g) => g.email)).toEqual([
      'dana@x.example',
      'sam@x.example',
      'dana@y.example',
    ]);
  });

  it('snapshots the email DOMAIN alongside the address, as the grant’s evidence', async () => {
    await inviteGuests(invite([{ email: 'Dana@Northwind.Example' }]));

    expect(onlyPreparedGuest().emailDomain).toBe('northwind.example');
  });
});

// ── inviteGuests — D4, the delegate refusal ──────────────────────────────────────────

describe('inviteGuests — a delegate must be CLIENT-side (D4)', () => {
  it('⚠ refuses an expert-side delegate BEFORE the database, so the caller gets a legible code', async () => {
    // The CHECK `meeting_guest_delegate_is_client_side` is the BACKSTOP, not the UX: reaching
    // it would surface a raw `23514` as a 500.
    mockAuthorizeMeetingParticipation.mockResolvedValue(gateOk({ side: 'expert' }));

    const result = await inviteGuests(
      invite([{ email: 'sam@cloudpeak.example', participationRole: 'delegate' }])
    );

    expect(result).toEqual({ ok: false, code: 'delegate_must_be_client_side' });
    expect(mockCreateMany).not.toHaveBeenCalled();
  });

  it('refuses before it even mints a token or counts the cap', async () => {
    mockAuthorizeMeetingParticipation.mockResolvedValue(gateOk({ side: 'expert' }));

    await inviteGuests(invite([{ email: 'sam@cloudpeak.example', participationRole: 'delegate' }]));

    expect(mockMintGuestInviteToken).not.toHaveBeenCalled();
    expect(mockCountLiveByMeeting).not.toHaveBeenCalled();
  });

  it('refuses the WHOLE batch when one member of it is an expert-side delegate', async () => {
    mockAuthorizeMeetingParticipation.mockResolvedValue(gateOk({ side: 'expert' }));

    const result = await inviteGuests(
      invite([
        { email: 'ok@cloudpeak.example', participationRole: 'guest' },
        { email: 'sam@cloudpeak.example', participationRole: 'delegate' },
      ])
    );

    expect(result).toEqual({ ok: false, code: 'delegate_must_be_client_side' });
    expect(mockCreateMany).not.toHaveBeenCalled();
  });

  it('ACCEPTS a client-side delegate and writes the role through', async () => {
    const result = await inviteGuests(
      invite([{ email: 'dana@northwind.example', participationRole: 'delegate' }])
    );

    expect(result.ok).toBe(true);
    expect(onlyPreparedGuest().participationRole).toBe('delegate');
  });

  it('ACCEPTS an expert-side `guest` — only the delegate role is refused', async () => {
    mockAuthorizeMeetingParticipation.mockResolvedValue(gateOk({ side: 'expert' }));

    const result = await inviteGuests(
      invite([{ email: 'sam@cloudpeak.example', participationRole: 'guest' }])
    );

    expect(result.ok).toBe(true);
    expect(onlyPreparedGuest().participationRole).toBe('guest');
  });

  it('defaults an unspecified role to `guest` (attends ALONGSIDE, not instead of)', async () => {
    await inviteGuests(invite([{ email: 'dana@northwind.example' }]));

    expect(onlyPreparedGuest().participationRole).toBe('guest');
  });
});

// ── inviteGuests — D6, resolveGuestAccessScope ───────────────────────────────────────

describe('inviteGuests — the access scope, computed once at invite time and STORED', () => {
  /**
   * `engagement` (the WHOLE retrospective envelope) needs ALL FOUR conditions. Each row below
   * breaks exactly one of them, so a regression in any single condition fails exactly one row.
   */
  it('(a) engagement grain + client side + corporate domain + a REGISTERED domain → `engagement`', async () => {
    mockListDomainsByParty.mockResolvedValue([{ domain: 'northwind.example' }]);

    await inviteGuests(invite([{ email: 'dana@northwind.example' }]));

    expect(onlyPreparedGuest().accessScope).toBe('engagement');
    expect(mockListDomainsByParty).toHaveBeenCalledWith('company', COMPANY_ID);
  });

  it.each([
    { label: 'gmail.com — FREEMAIL', email: 'dana@gmail.com', registered: 'gmail.com' },
    {
      label: 'mailinator.com — DISPOSABLE',
      email: 'dana@mailinator.com',
      registered: 'mailinator.com',
    },
  ])(
    '⚠ (b) $label yields `meeting` EVEN THOUGH the company registered that exact domain',
    async ({ email, registered }) => {
      // ⚠⚠ THE LOAD-BEARING EXCLUSION. A client company operating on gmail.com would otherwise
      // grant the whole retrospective engagement envelope to every Gmail address anyone typed.
      mockListDomainsByParty.mockResolvedValue([{ domain: registered }]);

      await inviteGuests(invite([{ email }]));

      expect(onlyPreparedGuest().accessScope).toBe('meeting');
    }
  );

  it('⚠ (c) an EXPERT-side guest is always `meeting`, and the client’s domains are never read', async () => {
    // The rule is defined against the CLIENT COMPANY's domains; an expert-side colleague
    // matching them would be a data anomaly, not a grant.
    mockAuthorizeMeetingParticipation.mockResolvedValue(gateOk({ side: 'expert' }));
    mockListDomainsByParty.mockResolvedValue([{ domain: 'cloudpeak.example' }]);

    await inviteGuests(invite([{ email: 'sam@cloudpeak.example' }]));

    expect(onlyPreparedGuest().accessScope).toBe('meeting');
    expect(mockListDomainsByParty).not.toHaveBeenCalled();
  });

  it.each([
    { contextType: 'project_discovery' as const, contextId: 'req-1' },
    { contextType: 'request_interaction' as const, contextId: 'rel-1' },
  ])(
    '(d) a $contextType context is always `meeting` — there is no engagement envelope to grant',
    async ({ contextType, contextId }) => {
      mockAuthorizeMeetingParticipation.mockResolvedValue(
        gateOk({ subject: { contextType, contextId } })
      );
      mockListDomainsByParty.mockResolvedValue([{ domain: 'northwind.example' }]);

      await inviteGuests(invite([{ email: 'dana@northwind.example' }]));

      expect(onlyPreparedGuest().accessScope).toBe('meeting');
      // Short-circuits before the registry read entirely.
      expect(mockListDomainsByParty).not.toHaveBeenCalled();
    }
  );

  it('(e) a CORPORATE domain that is NOT in `party_domains` → `meeting`', async () => {
    mockListDomainsByParty.mockResolvedValue([{ domain: 'northwind.example' }]);

    await inviteGuests(invite([{ email: 'dana@othercorp.example' }]));

    expect(onlyPreparedGuest().accessScope).toBe('meeting');
  });

  it('matches the registered domain EXACTLY — a subdomain is not a match', async () => {
    mockListDomainsByParty.mockResolvedValue([{ domain: 'northwind.example' }]);

    await inviteGuests(invite([{ email: 'dana@mail.northwind.example' }]));

    expect(onlyPreparedGuest().accessScope).toBe('meeting');
  });

  it('matches against ANY live registered domain, not just the first', async () => {
    mockListDomainsByParty.mockResolvedValue([
      { domain: 'legacy.example' },
      { domain: 'northwind.example' },
    ]);

    await inviteGuests(invite([{ email: 'dana@northwind.example' }]));

    expect(onlyPreparedGuest().accessScope).toBe('engagement');
  });

  it('resolves the scope PER GUEST inside one batch', async () => {
    mockListDomainsByParty.mockResolvedValue([{ domain: 'northwind.example' }]);

    await inviteGuests(
      invite([
        { email: 'dana@northwind.example' },
        { email: 'external@othercorp.example' },
        { email: 'personal@gmail.com' },
      ])
    );

    expect(createManyArgs().guests.map((g) => g.accessScope)).toEqual([
      'engagement',
      'meeting',
      'meeting',
    ]);
  });

  it('reports the scope back to the caller and tags analytics with `same_domain`', async () => {
    mockListDomainsByParty.mockResolvedValue([{ domain: 'northwind.example' }]);

    const result = await inviteGuests(invite([{ email: 'dana@northwind.example' }]));

    expect(result).toMatchObject({ ok: true, guests: [{ accessScope: 'engagement' }] });
    expect(mockTrackServer).toHaveBeenCalledWith(
      'guest_invited',
      expect.objectContaining({
        access_scope: 'engagement',
        // ⚠ A BOOLEAN, never the domain itself.
        same_domain: true,
        party: 'client',
        entry_point: 'case_surface',
        context_type: 'case',
        distinct_id: USER_ID,
      })
    );
    const [, properties] = mockTrackServer.mock.calls[0] ?? [];
    expect(JSON.stringify(properties)).not.toContain('northwind.example');
    expect(JSON.stringify(properties)).not.toContain('dana@');
  });
});

// ── inviteGuests — meeting state ─────────────────────────────────────────────────────

describe('inviteGuests — the TERMINAL set closes a meeting, never an allow-list', () => {
  it.each(['ended', 'cancelled'])('refuses on status `%s`', async (status) => {
    mockAuthorizeMeetingParticipation.mockResolvedValue(
      gateOk({ meeting: meetingRow({ status }) })
    );

    const result = await inviteGuests(invite([{ email: 'dana@northwind.example' }]));

    expect(result).toEqual({ ok: false, code: 'meeting_not_open_for_guests' });
    expect(mockCreateMany).not.toHaveBeenCalled();
  });

  it.each([
    'scheduled',
    // ⚠ THE IMPORTANT ONE. An `IN ('scheduled','in_progress')` allow-list would have silently
    // excluded the lobby state in which admit/deny matters most.
    'waiting_for_participants',
    'in_progress',
  ])('SUCCEEDS on status `%s`', async (status) => {
    mockAuthorizeMeetingParticipation.mockResolvedValue(
      gateOk({ meeting: meetingRow({ status }) })
    );

    const result = await inviteGuests(invite([{ email: 'dana@northwind.example' }]));

    expect(result.ok).toBe(true);
  });

  it('⚠ a status label nobody has invented yet defaults to OPEN, which is the right direction', async () => {
    mockAuthorizeMeetingParticipation.mockResolvedValue(
      gateOk({ meeting: meetingRow({ status: 'rescheduling' }) })
    );

    const result = await inviteGuests(invite([{ email: 'dana@northwind.example' }]));

    expect(result.ok).toBe(true);
  });

  it('⚠ checks state AFTER authorization — a gate refusal never leaks the state', async () => {
    mockAuthorizeMeetingParticipation.mockResolvedValue({ ok: false, code: 'meeting_not_found' });

    const result = await inviteGuests(invite([{ email: 'dana@northwind.example' }]));

    expect(result).toEqual({ ok: false, code: 'meeting_not_found' });
    expect(mockCountLiveByMeeting).not.toHaveBeenCalled();
    expect(mockCreateMany).not.toHaveBeenCalled();
  });
});

// ── inviteGuests — failure mapping and best-effort side effects ──────────────────────

describe('inviteGuests — a 23505 is a legible conflict, not a 500', () => {
  it('maps the live `(meeting_id, email)` unique violation to `guest_already_invited`', async () => {
    mockCreateMany.mockRejectedValue(Object.assign(new Error('duplicate key'), { code: '23505' }));

    const result = await inviteGuests(invite([{ email: 'dana@northwind.example' }]));

    expect(result).toEqual({ ok: false, code: 'guest_already_invited' });
  });

  it('maps a bare `{ code: "23505" }` object too — pg errors are not always Error instances', async () => {
    mockCreateMany.mockRejectedValue({ code: '23505' });

    const result = await inviteGuests(invite([{ email: 'dana@northwind.example' }]));

    expect(result).toEqual({ ok: false, code: 'guest_already_invited' });
  });

  it.each([
    {
      label: 'a CHECK violation (23514)',
      error: Object.assign(new Error('check'), { code: '23514' }),
    },
    { label: 'a bare Error with no code', error: new Error('connection reset') },
    { label: 'a non-object rejection', error: 'boom' },
  ])('RE-THROWS $label rather than mis-labelling it as a duplicate', async ({ error }) => {
    mockCreateMany.mockRejectedValue(error);

    await expect(inviteGuests(invite([{ email: 'dana@northwind.example' }]))).rejects.toBeDefined();
  });
});

describe('inviteGuests — notifications and analytics are BEST-EFFORT over committed rows', () => {
  it('⚠ a publish failure does NOT fail an invite whose rows are already durable', async () => {
    mockPublish.mockRejectedValue(new Error('Redis unavailable'));

    const result = await inviteGuests(invite([{ email: 'dana@northwind.example' }]));

    expect(result).toMatchObject({ ok: true, participantCount: 3 });
    if (result.ok) expect(result.guests).toHaveLength(1);
  });

  it('still records analytics when the notification publish threw', async () => {
    mockPublish.mockRejectedValue(new Error('Redis unavailable'));

    await inviteGuests(invite([{ email: 'dana@northwind.example' }]));

    expect(mockTrackServer).toHaveBeenCalledWith('guest_invited', expect.anything());
  });

  it('a FAILED guest-invite publish does not stop the next guest’s publish', async () => {
    mockListAdminUserIds.mockResolvedValue([ADMIN_A]);
    mockPublish.mockRejectedValueOnce(new Error('transient')).mockResolvedValue(undefined);

    const result = await inviteGuests(
      invite([{ email: 'a@northwind.example' }, { email: 'b@northwind.example' }])
    );

    expect(result.ok).toBe(true);
    expect(publishedPayloads('meeting.guest_invited')).toHaveLength(2);
    expect(publishedPayloads('meeting.guest_added')).toHaveLength(2);
  });

  it('a title lookup that THROWS degrades to the generic label instead of failing the invite', async () => {
    mockCaseFindByEngagementId.mockRejectedValue(new Error('db blip'));

    const result = await inviteGuests(invite([{ email: 'dana@northwind.example' }]));

    expect(result.ok).toBe(true);
    const [payload] = publishedPayloads('meeting.guest_invited');
    expect(payload?.meetingTitle).toBe('a consultation');
  });
});

// ── inviteGuests — the guest-facing payload ──────────────────────────────────────────

describe('inviteGuests — the guest invite payload', () => {
  it('carries the meeting window, the resolved title and the pre-formatted UTC expiry date', async () => {
    await inviteGuests(invite([{ email: 'dana@northwind.example', name: 'Dana' }]));

    const [payload] = publishedPayloads('meeting.guest_invited');
    expect(payload).toMatchObject({
      recipientEmail: 'dana@northwind.example',
      guestName: 'Dana',
      meetingTitle: 'CPQ implementation',
      scheduledStartIso: SCHEDULED_START.toISOString(),
      scheduledEndIso: SCHEDULED_END.toISOString(),
      accessScope: 'meeting',
      // 7 days past 1 Sep 2026.
      expiresOn: '8 September 2026',
    });
  });

  it('OMITS `guestName` entirely for a nameless guest, so the email greets generically', async () => {
    await inviteGuests(invite([{ email: 'dana@northwind.example' }]));

    const [payload] = publishedPayloads('meeting.guest_invited');
    expect(payload).toBeDefined();
    expect('guestName' in (payload ?? {})).toBe(false);
  });

  it('attributes a CLIENT-side inviter to the client COMPANY', async () => {
    await inviteGuests(invite([{ email: 'dana@northwind.example' }]));

    const [payload] = publishedPayloads('meeting.guest_invited');
    expect(payload).toMatchObject({
      inviterName: 'Priya Nair',
      inviterOrgLabel: 'Northwind Industrial',
    });
  });

  it('attributes an AGENCY-based expert inviter to the AGENCY', async () => {
    mockAuthorizeMeetingParticipation.mockResolvedValue(gateOk({ side: 'expert' }));

    await inviteGuests(invite([{ email: 'sam@cloudpeak.example' }]));

    const [payload] = publishedPayloads('meeting.guest_invited');
    expect(payload).toMatchObject({ inviterName: 'Priya Nair', inviterOrgLabel: 'CloudPeak' });
  });

  it('⚠ an INDEPENDENT expert keeps their OWN name — never a bare "the expert"', async () => {
    mockAuthorizeMeetingParticipation.mockResolvedValue(gateOk({ side: 'expert' }));
    mockExpertFindProfileById.mockResolvedValue({ agencyId: null });

    await inviteGuests(invite([{ email: 'sam@cloudpeak.example' }]));

    const [payload] = publishedPayloads('meeting.guest_invited');
    expect(payload).toMatchObject({ inviterName: 'Priya Nair', inviterOrgLabel: 'Priya Nair' });
    expect(mockAgencyGetSummaryById).not.toHaveBeenCalled();
  });

  it('falls back to a neutral noun when the inviter’s user row has no name', async () => {
    mockUserFindById.mockResolvedValue({ firstName: null, lastName: null });

    await inviteGuests(invite([{ email: 'dana@northwind.example' }]));

    const [payload] = publishedPayloads('meeting.guest_invited');
    expect(payload?.inviterName).toBe('A colleague');
  });

  it('correlates on the guest ROW ID — the safe handle for a re-send', async () => {
    await inviteGuests(invite([{ email: 'dana@northwind.example' }]));

    const [payload] = publishedPayloads('meeting.guest_invited');
    expect(payload?.correlationId).toBe('guest-0');
  });

  it('returns the created rows without a token or a hash of one', async () => {
    const result = await inviteGuests(invite([{ email: 'dana@northwind.example', name: 'Dana' }]));

    expect(result).toMatchObject({
      ok: true,
      guests: [
        {
          id: 'guest-0',
          email: 'dana@northwind.example',
          name: 'Dana',
          party: 'client',
          participationRole: 'guest',
          accessScope: 'meeting',
          admission: 'pre_admitted',
          invitedAt: CREATED_AT.toISOString(),
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('raw-token');
    expect(JSON.stringify(result)).not.toContain('digest-');
  });
});

// ── listGuests ───────────────────────────────────────────────────────────────────────

describe('listGuests — the PARTY-SCOPED roster', () => {
  const CLIENT_ROW = {
    id: 'g-client',
    email: 'dana@northwind.example',
    emailDomain: 'northwind.example',
    name: 'Dana',
    party: 'client',
    participationRole: 'guest',
    accessScope: 'engagement',
    admission: 'pre_admitted',
  };
  const EXPERT_ROW = {
    id: 'g-expert',
    email: 'sam@cloudpeak.example',
    emailDomain: 'cloudpeak.example',
    name: 'Sam',
    party: 'expert',
    participationRole: 'guest',
    accessScope: 'meeting',
    admission: 'pre_admitted',
  };

  it('⚠ a CROSS-PARTY row has NO `email` key at all — absent, not null', async () => {
    // `JSON.stringify` drops an absent key entirely, so the wire carries no `"email": null`
    // for a future client to render as a blank placeholder.
    mockListLiveByMeeting.mockResolvedValue([EXPERT_ROW]);

    const result = await listGuests({ meetingId: MEETING_ID, actorUserId: USER_ID });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [guest] = result.guests;
    expect(guest).toBeDefined();
    expect('email' in (guest ?? {})).toBe(false);
    expect('emailDomain' in (guest ?? {})).toBe(false);
    expect('accessScope' in (guest ?? {})).toBe(false);
  });

  it('a cross-party row still carries the NAME — names cross the boundary', async () => {
    mockListLiveByMeeting.mockResolvedValue([EXPERT_ROW]);

    const result = await listGuests({ meetingId: MEETING_ID, actorUserId: USER_ID });

    if (!result.ok) throw new Error('expected ok');
    expect(result.guests[0]).toMatchObject({ name: 'Sam', displayName: 'Sam', party: 'expert' });
    expect(JSON.stringify(result.guests)).not.toContain('cloudpeak.example');
  });

  it('a nameless cross-party guest displays as the literal "Guest", never an email local part', async () => {
    mockListLiveByMeeting.mockResolvedValue([{ ...EXPERT_ROW, name: null }]);

    const result = await listGuests({ meetingId: MEETING_ID, actorUserId: USER_ID });

    if (!result.ok) throw new Error('expected ok');
    expect(result.guests[0]?.displayName).toBe('Guest');
    expect(JSON.stringify(result.guests)).not.toContain('sam');
  });

  it('a SAME-PARTY row keeps its address, domain and scope', async () => {
    mockListLiveByMeeting.mockResolvedValue([CLIENT_ROW]);

    const result = await listGuests({ meetingId: MEETING_ID, actorUserId: USER_ID });

    if (!result.ok) throw new Error('expected ok');
    expect(result.guests[0]).toMatchObject({
      email: 'dana@northwind.example',
      emailDomain: 'northwind.example',
      accessScope: 'engagement',
      displayName: 'Dana',
    });
  });

  it('projects EVERY row, not just the first', async () => {
    mockListLiveByMeeting.mockResolvedValue([CLIENT_ROW, EXPERT_ROW]);

    const result = await listGuests({ meetingId: MEETING_ID, actorUserId: USER_ID });

    if (!result.ok) throw new Error('expected ok');
    expect(result.guests).toHaveLength(2);
    expect('email' in (result.guests[0] ?? {})).toBe(true);
    expect('email' in (result.guests[1] ?? {})).toBe(false);
  });

  it('flips which rows are concealed when the viewer is on the EXPERT side', async () => {
    mockAuthorizeMeetingParticipation.mockResolvedValue(gateOk({ side: 'expert' }));
    mockListLiveByMeeting.mockResolvedValue([CLIENT_ROW, EXPERT_ROW]);

    const result = await listGuests({ meetingId: MEETING_ID, actorUserId: USER_ID });

    if (!result.ok) throw new Error('expected ok');
    expect('email' in (result.guests[0] ?? {})).toBe(false);
    expect('email' in (result.guests[1] ?? {})).toBe(true);
  });

  it('⚠ computes `canHost` with `host_meetings` — the LIVE right, NOT `manage_engagement`', async () => {
    // Inviting is administrative; hosting is live/in-meeting. The two tokens share a holder
    // set today, and gating on the one that MEANS this keeps that an implementation detail.
    mockHasEngagementCapability.mockResolvedValue(true);

    const result = await listGuests({ meetingId: MEETING_ID, actorUserId: USER_ID });

    expect(mockHasEngagementCapability).toHaveBeenCalledWith(
      { id: USER_ID },
      'host_meetings',
      CLIENT_SUBJECT
    );
    expect(mockHasEngagementCapability).not.toHaveBeenCalledWith(
      expect.anything(),
      'manage_engagement',
      expect.anything()
    );
    expect(result).toMatchObject({ ok: true, canHost: true });
  });

  it('reports `canHost: false` for a client-side member, who is never a delivery host', async () => {
    const result = await listGuests({ meetingId: MEETING_ID, actorUserId: USER_ID });

    expect(result).toMatchObject({ ok: true, canHost: false });
  });

  it.each(['ended', 'cancelled'])(
    '⚠ SUCCEEDS on an `%s` meeting — the roster is the record of who was on the call',
    async (status) => {
      // The deliberate read/mutate asymmetry: inviting someone to a call that already happened
      // is meaningless, but reading who attended it is not.
      mockAuthorizeMeetingParticipation.mockResolvedValue(
        gateOk({ meeting: meetingRow({ status }) })
      );
      mockListLiveByMeeting.mockResolvedValue([CLIENT_ROW]);

      const result = await listGuests({ meetingId: MEETING_ID, actorUserId: USER_ID });

      expect(result.ok).toBe(true);
    }
  );

  it('returns the gate’s literal when the actor is on neither side', async () => {
    mockAuthorizeMeetingParticipation.mockResolvedValue({ ok: false, code: 'meeting_not_found' });

    const result = await listGuests({ meetingId: MEETING_ID, actorUserId: USER_ID });

    expect(result).toEqual({ ok: false, code: 'meeting_not_found' });
    expect(mockListLiveByMeeting).not.toHaveBeenCalled();
    expect(mockHasEngagementCapability).not.toHaveBeenCalled();
  });

  it('counts the reserved seats into the roster total', async () => {
    mockListLiveByMeeting.mockResolvedValue([CLIENT_ROW, EXPERT_ROW]);
    mockCountLiveByMeeting.mockResolvedValue(2);

    const result = await listGuests({ meetingId: MEETING_ID, actorUserId: USER_ID });

    expect(result).toMatchObject({ ok: true, participantCount: 4, participantCap: 10 });
  });

  /**
   * ── ⚠⚠ THE ROSTER'S NUMBER AND THE INVITE GATE'S NUMBER ARE THE SAME NUMBER ─────────────
   *
   * `participantCount` used to be `RESERVED_BASE_PARTICIPANTS + rows.length`, where `rows`
   * comes from `listLiveByMeeting` — which filters `deleted_at` / `revoked_at` only and so
   * counts `pending` knocks and expired handles. `inviteGuests` gates on `countLiveByMeeting`,
   * which counts SEATS. Nothing produced a `pending` row before BAL-132, so the two happened
   * to agree; the lobby makes them diverge, and the route tells consumers to render
   * "{n} of 10" from these fields and never a local count.
   */
  it('⚠⚠ reports the SEAT count, NOT the row count — pending knocks are not seats', async () => {
    // Five queued knocks and no seats taken: the roster has five rows and zero occupants.
    const knock = { ...CLIENT_ROW, id: 'g-knock', admission: 'pending' };
    mockListLiveByMeeting.mockResolvedValue([knock, knock, knock, knock, knock]);
    mockCountLiveByMeeting.mockResolvedValue(0);

    const result = await listGuests({ meetingId: MEETING_ID, actorUserId: USER_ID });

    if (!result.ok) throw new Error('expected ok');
    // The old expression would have said `7` here — a nearly-full meeting — while
    // `inviteGuests` computed `2` and accepted eight more.
    expect(result.participantCount).toBe(2);
    expect(result.guests).toHaveLength(5);
    expect(mockCountLiveByMeeting).toHaveBeenCalledWith(MEETING_ID);
  });

  it('⚠ agrees with `inviteGuests` BY CONSTRUCTION — both read the same counter', async () => {
    // Not "the two predicates match" — the same function is called on both paths, so they
    // cannot drift. Seven seats: the invite gate accepts one more guest and no more.
    mockCountLiveByMeeting.mockResolvedValue(7);
    mockListLiveByMeeting.mockResolvedValue([CLIENT_ROW]);

    const listed = await listGuests({ meetingId: MEETING_ID, actorUserId: USER_ID });
    const invited = await inviteGuests(invite([{ email: 'dana@northwind.example' }]));

    if (!listed.ok || !invited.ok) throw new Error('expected both to succeed');
    expect(listed.participantCount).toBe(9);
    expect(invited.participantCount).toBe(10);

    const overflow = await inviteGuests(
      invite([{ email: 'a@northwind.example' }, { email: 'b@northwind.example' }])
    );
    expect(overflow).toEqual({ ok: false, code: 'participant_cap_reached' });
  });

  it('publishes nothing and tracks nothing — a read has no side effects', async () => {
    mockListLiveByMeeting.mockResolvedValue([CLIENT_ROW]);

    await listGuests({ meetingId: MEETING_ID, actorUserId: USER_ID });

    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockTrackServer).not.toHaveBeenCalled();
  });
});

// ── removeGuest ──────────────────────────────────────────────────────────────────────

describe('removeGuest — the SAME-PARTY rule', () => {
  const LIVE_CLIENT_GUEST = {
    id: GUEST_ID,
    meetingId: MEETING_ID,
    email: 'dana@northwind.example',
    name: 'Dana',
    party: 'client',
    accessScope: 'engagement',
    accessCount: 0,
  };

  function remove(): Promise<unknown> {
    return removeGuest({ meetingId: MEETING_ID, guestId: GUEST_ID, actorUserId: USER_ID });
  }

  it('⚠ refuses a CROSS-PARTY removal with the SAME literal a missing guest gets', async () => {
    // Identical on the wire, so the route is not an oracle for "does the other side have a
    // guest with this id".
    mockFindLiveById.mockResolvedValue({ ...LIVE_CLIENT_GUEST, party: 'expert' });

    await expect(remove()).resolves.toEqual({ ok: false, code: 'guest_not_found' });
    expect(mockRevoke).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockTrackServer).not.toHaveBeenCalled();
  });

  it('refuses an unknown guest id with that same literal', async () => {
    mockFindLiveById.mockResolvedValue(undefined);

    await expect(remove()).resolves.toEqual({ ok: false, code: 'guest_not_found' });
    expect(mockRevoke).not.toHaveBeenCalled();
  });

  it('scopes the lookup to the ALREADY-AUTHORIZED meeting, so another meeting’s id misses', async () => {
    await remove();

    expect(mockFindLiveById).toHaveBeenCalledWith(MEETING_ID, GUEST_ID);
  });

  it('revokes a same-party guest, attributing the removal to the actor', async () => {
    mockFindLiveById.mockResolvedValue(LIVE_CLIENT_GUEST);
    mockRevoke.mockResolvedValue(LIVE_CLIENT_GUEST);

    await expect(remove()).resolves.toEqual({ ok: true });
    expect(mockRevoke).toHaveBeenCalledWith({ guestId: GUEST_ID, revokedByUserId: USER_ID });
  });

  it('emails that person and ONLY that person', async () => {
    mockFindLiveById.mockResolvedValue(LIVE_CLIENT_GUEST);
    mockRevoke.mockResolvedValue(LIVE_CLIENT_GUEST);

    await remove();

    const payloads = publishedPayloads('meeting.guest_removed');
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      correlationId: GUEST_ID,
      recipientEmail: 'dana@northwind.example',
      guestName: 'Dana',
      meetingTitle: 'CPQ implementation',
      scheduledStartIso: SCHEDULED_START.toISOString(),
    });
    // ⚠ No same-party FYI on removal.
    expect(publishedPayloads('meeting.guest_added')).toHaveLength(0);
  });

  it('OMITS `guestName` for a nameless guest', async () => {
    mockFindLiveById.mockResolvedValue({ ...LIVE_CLIENT_GUEST, name: null });
    mockRevoke.mockResolvedValue({ ...LIVE_CLIENT_GUEST, name: null });

    await remove();

    const [payload] = publishedPayloads('meeting.guest_removed');
    expect('guestName' in (payload ?? {})).toBe(false);
  });

  it.each([
    { accessCount: 0, hadJoined: false },
    { accessCount: 3, hadJoined: true },
  ])(
    'records `had_joined: $hadJoined` from an access count of $accessCount',
    async ({ accessCount, hadJoined }) => {
      mockFindLiveById.mockResolvedValue(LIVE_CLIENT_GUEST);
      mockRevoke.mockResolvedValue({ ...LIVE_CLIENT_GUEST, accessCount });

      await remove();

      expect(mockTrackServer).toHaveBeenCalledWith('guest_removed', {
        party: 'client',
        access_scope: 'engagement',
        had_joined: hadJoined,
        distinct_id: USER_ID,
      });
    }
  );

  it('answers `guest_not_found` when it loses a race with a concurrent removal', async () => {
    mockFindLiveById.mockResolvedValue(LIVE_CLIENT_GUEST);
    mockRevoke.mockResolvedValue(undefined);

    await expect(remove()).resolves.toEqual({ ok: false, code: 'guest_not_found' });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('⚠ a publish failure does NOT undo a committed revocation', async () => {
    mockFindLiveById.mockResolvedValue(LIVE_CLIENT_GUEST);
    mockRevoke.mockResolvedValue(LIVE_CLIENT_GUEST);
    mockPublish.mockRejectedValue(new Error('Redis unavailable'));

    await expect(remove()).resolves.toEqual({ ok: true });
    expect(mockTrackServer).toHaveBeenCalledWith('guest_removed', expect.anything());
  });

  /**
   * ⚠⚠ REVOCATION IS THE ONE GUEST MUTATION THAT SURVIVES A TERMINAL MEETING, AND THIS TEST
   * IS THE INVERSE OF WHAT IT ONCE ASSERTED. `removeGuest` used to share `authorizeMutation`
   * with invite and admit/deny, so an `ended` meeting answered `meeting_not_open_for_guests`
   * — while `findLiveByTokenHash` deliberately KEEPS RESOLVING for `ended` for the whole
   * 7-day `GUEST_TOKEN_TTL_AFTER_END_MS` window. The two together meant a live link showing
   * the inviter, the counterparty org and every other guest's name, with no way to switch it
   * off for a week, in flat contradiction of the invite email's "if your invitation is
   * withdrawn, the link stops working straight away".
   *
   * `cancelled` is included for completeness rather than for parity: that lookup already
   * excludes cancelled meetings, so the credential is dead either way — but the operator
   * must still be able to record the removal.
   */
  it.each(['ended', 'cancelled'])(
    'SUCCEEDS on an `%s` meeting — the link outlives the call, so revocation must too',
    async (status) => {
      mockAuthorizeMeetingParticipation.mockResolvedValue(
        gateOk({ meeting: meetingRow({ status }) })
      );
      mockFindLiveById.mockResolvedValue(LIVE_CLIENT_GUEST);
      mockRevoke.mockResolvedValue(LIVE_CLIENT_GUEST);

      await expect(remove()).resolves.toEqual({ ok: true });
      expect(mockRevoke).toHaveBeenCalledWith({ guestId: GUEST_ID, revokedByUserId: USER_ID });
    }
  );

  it('⚠ removal on an `ended` meeting still emails that person, so the withdrawal is not silent', async () => {
    // The companion half: removal after the call must not become a book-keeping no-op. The
    // guest whose 7-day link just died is told, exactly as they are told before the call.
    // (That `revoke` is what actually kills the token — both `revoked_at` AND `deleted_at`,
    // which `findLiveByTokenHash` requires to be NULL — is pinned against a real Postgres in
    // `meeting-guests.integration.test.ts`, including the `ended`-meeting case.)
    mockAuthorizeMeetingParticipation.mockResolvedValue(
      gateOk({ meeting: meetingRow({ status: 'ended' }) })
    );
    mockFindLiveById.mockResolvedValue(LIVE_CLIENT_GUEST);
    mockRevoke.mockResolvedValue(LIVE_CLIENT_GUEST);

    await expect(remove()).resolves.toEqual({ ok: true });
    expect(publishedPayloads('meeting.guest_removed')).toHaveLength(1);
  });

  it('returns the gate’s literal, and touches no guest row, when authorization fails', async () => {
    mockAuthorizeMeetingParticipation.mockResolvedValue({ ok: false, code: 'meeting_not_found' });

    await expect(remove()).resolves.toEqual({ ok: false, code: 'meeting_not_found' });
    expect(mockFindLiveById).not.toHaveBeenCalled();
    expect(mockRevoke).not.toHaveBeenCalled();
  });
});

// ── decideGuestAdmission ─────────────────────────────────────────────────────────────

describe('decideGuestAdmission — TWO gates, in order, both fail-closed', () => {
  const PENDING_GUEST = { id: GUEST_ID, meetingId: MEETING_ID, party: 'client' };
  const DECIDED_AT = new Date('2026-09-01T10:05:00.000Z');

  function decide(decision: 'admitted' | 'denied' = 'admitted'): Promise<unknown> {
    return decideGuestAdmission({
      meetingId: MEETING_ID,
      guestId: GUEST_ID,
      actorUserId: USER_ID,
      decision,
    });
  }

  it('⚠ runs the TENANCY gate FIRST — a gate refusal never reaches the engagement axis', async () => {
    // `hasEngagementCapability` answers whether the actor may HOST an already-identified
    // context, never whether they were entitled to know it exists.
    mockAuthorizeMeetingParticipation.mockResolvedValue({ ok: false, code: 'meeting_not_found' });

    await expect(decide()).resolves.toEqual({ ok: false, code: 'meeting_not_found' });
    expect(mockHasEngagementCapability).not.toHaveBeenCalled();
    expect(mockFindLiveById).not.toHaveBeenCalled();
  });

  it('⚠ asks for `host_meetings` on the gate’s resolved subject, never `manage_engagement`', async () => {
    mockHasEngagementCapability.mockResolvedValue(true);
    mockFindLiveById.mockResolvedValue(PENDING_GUEST);

    await decide();

    expect(mockHasEngagementCapability).toHaveBeenCalledWith(
      { id: USER_ID },
      'host_meetings',
      CLIENT_SUBJECT
    );
    expect(mockHasEngagementCapability).not.toHaveBeenCalledWith(
      expect.anything(),
      'manage_engagement',
      expect.anything()
    );
  });

  it('⚠ a NON-HOLDER gets `meeting_not_found` — collapsed into the gate’s literal, never a 403', async () => {
    mockHasEngagementCapability.mockResolvedValue(false);
    mockFindLiveById.mockResolvedValue(PENDING_GUEST);

    await expect(decide()).resolves.toEqual({ ok: false, code: 'meeting_not_found' });
    // A non-holder learns nothing about the meeting — not even that the guest exists.
    expect(mockFindLiveById).not.toHaveBeenCalled();
    expect(mockDecideAdmission).not.toHaveBeenCalled();
  });

  it('answers `guest_not_found` for an unknown guest id', async () => {
    mockHasEngagementCapability.mockResolvedValue(true);
    mockFindLiveById.mockResolvedValue(undefined);

    await expect(decide()).resolves.toEqual({ ok: false, code: 'guest_not_found' });
    expect(mockDecideAdmission).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'the compare-and-set matched nothing', decided: undefined },
    {
      label: 'the row came back with no decision timestamp',
      decided: { id: GUEST_ID, party: 'client', admissionDecidedAt: null },
    },
  ])('answers `guest_not_pending` when $label', async ({ decided }) => {
    mockHasEngagementCapability.mockResolvedValue(true);
    mockFindLiveById.mockResolvedValue(PENDING_GUEST);
    mockDecideAdmission.mockResolvedValue(decided);

    await expect(decide()).resolves.toEqual({ ok: false, code: 'guest_not_pending' });
    expect(mockTrackServer).not.toHaveBeenCalled();
  });

  it.each([
    { decision: 'admitted' as const, event: 'guest_admitted' },
    { decision: 'denied' as const, event: 'guest_denied' },
  ])('records a $decision decision and PUBLISHES NOTHING', async ({ decision, event }) => {
    mockHasEngagementCapability.mockResolvedValue(true);
    mockFindLiveById.mockResolvedValue(PENDING_GUEST);
    mockDecideAdmission.mockResolvedValue({
      id: GUEST_ID,
      party: 'client',
      // BAL-132: the analytics payload reads this off the DECIDED ROW, never request input.
      inviteChannel: 'link',
      admissionDecidedAt: DECIDED_AT,
    });

    await expect(decide(decision)).resolves.toEqual({
      ok: true,
      id: GUEST_ID,
      admission: decision,
      decidedAt: DECIDED_AT.toISOString(),
    });
    expect(mockDecideAdmission).toHaveBeenCalledWith({
      guestId: GUEST_ID,
      decision,
      deciderUserId: USER_ID,
    });
    // ⚠ NO NOTIFICATION ON EITHER BRANCH. The person is in the lobby watching the UI: an
    // email after a DENY is hostile and one after an ADMIT is redundant.
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockTrackServer).toHaveBeenCalledWith(event, {
      party: 'client',
      // ⚠ BAL-132. Without this, `party` is unreadable in PostHog: a `link`-channel row's
      // `party` is a lobby PLACEHOLDER (`client` because the column is NOT NULL), so every
      // admit/deny would look client-side. This row is deliberately a `link` one.
      invite_channel: 'link',
      distinct_id: USER_ID,
    });
  });

  it.each(['ended', 'cancelled'])(
    'refuses on an `%s` meeting before the host check — engagement lifecycle is ours, not BAL-413’s',
    async (status) => {
      // `hasEngagementCapability` never reads `engagements.status`, so a completed
      // engagement's expert still holds both tokens. Meeting liveness is this service's job.
      mockAuthorizeMeetingParticipation.mockResolvedValue(
        gateOk({ meeting: meetingRow({ status }) })
      );

      await expect(decide()).resolves.toEqual({ ok: false, code: 'meeting_not_open_for_guests' });
      expect(mockHasEngagementCapability).not.toHaveBeenCalled();
    }
  );

  /**
   * ── ⚠⚠ THE SEAT CAP ON THE **SECOND** ADDITIVE PATH ─────────────────────────────────────
   *
   * `inviteGuests` was the only mutation that counted. That was sufficient only while a
   * `pending` row consumed a seat, because the queue then could not grow past the cap. BAL-132
   * split the counters on purpose — waiting is not holding — so `MAX_LOBBY_QUEUE` (25) knocks
   * can queue against one free seat, and admitting them one at a time would have walked a
   * 10-person meeting to 27 without ever consulting `MAX_MEETING_PARTICIPANTS`.
   */
  describe('the participant cap, re-checked on ADMIT only', () => {
    beforeEach(() => {
      mockHasEngagementCapability.mockResolvedValue(true);
      mockFindLiveById.mockResolvedValue(PENDING_GUEST);
      mockDecideAdmission.mockResolvedValue({
        id: GUEST_ID,
        party: 'client',
        inviteChannel: 'link',
        admissionDecidedAt: DECIDED_AT,
      });
    });

    it('⚠ REFUSES an admit that would exceed the cap, and writes nothing', async () => {
      // `MAX_MEETING_PARTICIPANTS` is 10 and `RESERVED_BASE_PARTICIPANTS` is 2 — the real
      // constants, deliberately unmocked — so 8 guest seats is a full room.
      mockCountLiveByMeeting.mockResolvedValue(8);

      await expect(decide('admitted')).resolves.toEqual({
        ok: false,
        code: 'participant_cap_reached',
      });
      expect(mockDecideAdmission).not.toHaveBeenCalled();
      expect(mockTrackServer).not.toHaveBeenCalled();
    });

    it('admits at ONE BELOW the cap — `>=`, so the last seat is still fillable', async () => {
      mockCountLiveByMeeting.mockResolvedValue(7);

      await expect(decide('admitted')).resolves.toMatchObject({ ok: true, admission: 'admitted' });
      expect(mockDecideAdmission).toHaveBeenCalled();
    });

    it('⚠⚠ NEVER refuses a DENY for capacity — it is the only way to clear a flooded queue', async () => {
      // Gating deny on a full room would jam the one lever that unjams the meeting, and a deny
      // frees a queue slot rather than consuming a seat.
      mockCountLiveByMeeting.mockResolvedValue(50);

      await expect(decide('denied')).resolves.toMatchObject({ ok: true, admission: 'denied' });
      expect(mockDecideAdmission).toHaveBeenCalledWith({
        guestId: GUEST_ID,
        decision: 'denied',
        deciderUserId: USER_ID,
      });
      // ⚠ And the counter is not even consulted on that branch.
      expect(mockCountLiveByMeeting).not.toHaveBeenCalled();
    });

    it('⚠ counts only AFTER both gates and the guest lookup — never before authorization', async () => {
      // A distinct literal is safe here precisely because it is unreachable until the actor has
      // proven tenancy AND `host_meetings`. If the count ran first it would be an oracle.
      mockHasEngagementCapability.mockResolvedValue(false);
      mockCountLiveByMeeting.mockResolvedValue(8);

      await expect(decide('admitted')).resolves.toEqual({ ok: false, code: 'meeting_not_found' });
      expect(mockCountLiveByMeeting).not.toHaveBeenCalled();
    });

    it('⚠ an unknown guest id still answers `guest_not_found`, not the cap literal', async () => {
      mockFindLiveById.mockResolvedValue(undefined);
      mockCountLiveByMeeting.mockResolvedValue(8);

      await expect(decide('admitted')).resolves.toEqual({ ok: false, code: 'guest_not_found' });
      expect(mockCountLiveByMeeting).not.toHaveBeenCalled();
    });
  });
});
