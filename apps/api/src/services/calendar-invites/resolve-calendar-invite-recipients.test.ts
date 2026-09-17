import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockFindLatestByEntityAndAction,
  mockListByMeetingContexts,
  mockListLiveByMeetingGuests,
  mockGetMemberRole,
  mockResolveMeetingContextOwner,
  mockDeliveringExpertUserId,
} = vi.hoisted(() => ({
  mockFindLatestByEntityAndAction: vi.fn(),
  mockListByMeetingContexts: vi.fn(),
  mockListLiveByMeetingGuests: vi.fn(),
  mockGetMemberRole: vi.fn(),
  mockResolveMeetingContextOwner: vi.fn(),
  mockDeliveringExpertUserId: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  auditEventsRepository: { findLatestByEntityAndAction: mockFindLatestByEntityAndAction },
  meetingContextsRepository: { listByMeeting: mockListByMeetingContexts },
  meetingGuestsRepository: { listLiveByMeeting: mockListLiveByMeetingGuests },
  partyMembershipsRepository: { getMemberRole: mockGetMemberRole },
  resolveMeetingContextOwner: mockResolveMeetingContextOwner,
}));
vi.mock('../meetings/delivering-party.js', () => ({
  deliveringExpertUserId: mockDeliveringExpertUserId,
}));

const {
  resolveCalendarPartyMemberUserIds,
  listCalendarInviteGuestIds,
  resolveCalendarInviteRecipients,
} = await import('./resolve-calendar-invite-recipients.js');

const MEETING_ID = 'meeting-1';
const CASE_CONTEXT = [{ contextType: 'case', contextId: 'ctx-1' }];

beforeEach(() => {
  vi.clearAllMocks();
  mockListByMeetingContexts.mockResolvedValue(CASE_CONTEXT);
  mockResolveMeetingContextOwner.mockResolvedValue({
    companyId: 'company-1',
    expertProfileId: 'expert-profile-1',
  });
  mockGetMemberRole.mockResolvedValue('member');
});

describe('resolveCalendarPartyMemberUserIds — client', () => {
  it('resolves the booker from the meeting.booked audit actor', async () => {
    mockFindLatestByEntityAndAction.mockResolvedValue({ actorUserId: 'booker-1' });

    const ids = await resolveCalendarPartyMemberUserIds({
      meetingId: MEETING_ID,
      party: 'client',
      expertProfileId: null,
    });

    expect(ids).toEqual(['booker-1']);
    expect(mockFindLatestByEntityAndAction).toHaveBeenCalledWith({
      entityType: 'meeting',
      entityId: MEETING_ID,
      action: 'meeting.booked',
    });
    // F15 (fix round 1, R14) — pin the EXACT argument order: `getMemberRole` is checked against
    // the OWNING company and the BOOKER, never (say) the booker id for both, which the previous
    // `mockGetMemberRole.mockResolvedValue('member')` default would have let survive silently.
    expect(mockGetMemberRole).toHaveBeenCalledWith('company', 'company-1', 'booker-1');
  });

  it('a null actor (seeded meeting) ⇒ []', async () => {
    mockFindLatestByEntityAndAction.mockResolvedValue({ actorUserId: null });

    const ids = await resolveCalendarPartyMemberUserIds({
      meetingId: MEETING_ID,
      party: 'client',
      expertProfileId: null,
    });

    expect(ids).toEqual([]);
  });

  it('no audit row at all ⇒ []', async () => {
    mockFindLatestByEntityAndAction.mockResolvedValue(undefined);

    const ids = await resolveCalendarPartyMemberUserIds({
      meetingId: MEETING_ID,
      party: 'client',
      expertProfileId: null,
    });

    expect(ids).toEqual([]);
  });

  it('a booker who no longer holds participate on the owning company ⇒ []', async () => {
    mockFindLatestByEntityAndAction.mockResolvedValue({ actorUserId: 'booker-1' });
    mockGetMemberRole.mockResolvedValue(undefined);

    const ids = await resolveCalendarPartyMemberUserIds({
      meetingId: MEETING_ID,
      party: 'client',
      expertProfileId: null,
    });

    expect(ids).toEqual([]);
  });

  it('a booker whose role has no participate capability ⇒ []', async () => {
    mockFindLatestByEntityAndAction.mockResolvedValue({ actorUserId: 'booker-1' });
    // No such role exists in the shipped map, so it resolves to no capabilities — the
    // membership axis denies without needing a bespoke fixture role.
    mockGetMemberRole.mockResolvedValue('unknown-role');

    const ids = await resolveCalendarPartyMemberUserIds({
      meetingId: MEETING_ID,
      party: 'client',
      expertProfileId: null,
    });

    expect(ids).toEqual([]);
  });

  it('no resolvable primary context ⇒ []', async () => {
    mockFindLatestByEntityAndAction.mockResolvedValue({ actorUserId: 'booker-1' });
    mockListByMeetingContexts.mockResolvedValue([]);

    const ids = await resolveCalendarPartyMemberUserIds({
      meetingId: MEETING_ID,
      party: 'client',
      expertProfileId: null,
    });

    expect(ids).toEqual([]);
  });
});

describe('resolveCalendarPartyMemberUserIds — expert', () => {
  it('resolves via deliveringExpertUserId', async () => {
    mockDeliveringExpertUserId.mockResolvedValue('expert-user-1');

    const ids = await resolveCalendarPartyMemberUserIds({
      meetingId: MEETING_ID,
      party: 'expert',
      expertProfileId: 'expert-profile-1',
    });

    expect(ids).toEqual(['expert-user-1']);
    expect(mockDeliveringExpertUserId).toHaveBeenCalledWith('expert-profile-1');
  });

  it('a null delivering expert ⇒ []', async () => {
    mockDeliveringExpertUserId.mockResolvedValue(null);

    const ids = await resolveCalendarPartyMemberUserIds({
      meetingId: MEETING_ID,
      party: 'expert',
      expertProfileId: null,
    });

    expect(ids).toEqual([]);
  });
});

describe('listCalendarInviteGuestIds', () => {
  const GUESTS = [
    { id: 'g-pending', party: 'client', admission: 'pending' },
    { id: 'g-admitted', party: 'client', admission: 'admitted' },
    { id: 'g-pre-admitted', party: 'client', admission: 'pre_admitted' },
    { id: 'g-other-side', party: 'expert', admission: 'admitted' },
  ];

  it('a pending lobby row receives nothing — only admitted/pre_admitted seat-holders on the SAME side', async () => {
    mockListLiveByMeetingGuests.mockResolvedValue(GUESTS);

    const ids = await listCalendarInviteGuestIds({ meetingId: MEETING_ID, party: 'client' });

    expect(ids.sort((a, b) => a.localeCompare(b))).toEqual(['g-admitted', 'g-pre-admitted']);
  });

  it('the other side is excluded even when admitted', async () => {
    mockListLiveByMeetingGuests.mockResolvedValue(GUESTS);

    const ids = await listCalendarInviteGuestIds({ meetingId: MEETING_ID, party: 'expert' });

    expect(ids).toEqual(['g-other-side']);
  });
});

describe('resolveCalendarInviteRecipients', () => {
  beforeEach(() => {
    mockListLiveByMeetingGuests.mockResolvedValue([
      { id: 'guest-1', party: 'expert', admission: 'admitted' },
    ]);
  });

  it('client party: booker + guests, deliveryMode is irrelevant on this side', async () => {
    mockFindLatestByEntityAndAction.mockResolvedValue({ actorUserId: 'booker-1' });
    mockListLiveByMeetingGuests.mockResolvedValue([
      { id: 'guest-1', party: 'client', admission: 'admitted' },
    ]);

    const recipients = await resolveCalendarInviteRecipients({
      meetingId: MEETING_ID,
      party: 'client',
      deliveryMode: 'ics',
      expertProfileId: null,
    });

    expect(recipients).toEqual([
      { kind: 'user', userId: 'booker-1' },
      { kind: 'guest', guestId: 'guest-1' },
    ]);
  });

  it('expert party, row ics: the expert member is included alongside guests', async () => {
    mockDeliveringExpertUserId.mockResolvedValue('expert-user-1');

    const recipients = await resolveCalendarInviteRecipients({
      meetingId: MEETING_ID,
      party: 'expert',
      deliveryMode: 'ics',
      expertProfileId: 'expert-profile-1',
    });

    expect(recipients).toEqual([
      { kind: 'user', userId: 'expert-user-1' },
      { kind: 'guest', guestId: 'guest-1' },
    ]);
  });

  it('expert party, row provider_event: the expert MEMBER is omitted (Ruling 1) but guests are kept', async () => {
    mockDeliveringExpertUserId.mockResolvedValue('expert-user-1');

    const recipients = await resolveCalendarInviteRecipients({
      meetingId: MEETING_ID,
      party: 'expert',
      deliveryMode: 'provider_event',
      expertProfileId: 'expert-profile-1',
    });

    expect(recipients).toEqual([{ kind: 'guest', guestId: 'guest-1' }]);
    expect(mockDeliveringExpertUserId).not.toHaveBeenCalled();
  });
});
