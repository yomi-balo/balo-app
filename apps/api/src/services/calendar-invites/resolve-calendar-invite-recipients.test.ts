import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockFindBooker,
  mockBookerStillParticipates,
  mockListByMeetingContexts,
  mockListLiveByMeetingGuests,
  mockResolveMeetingContextOwner,
  mockDeliveringExpertUserId,
} = vi.hoisted(() => ({
  mockFindBooker: vi.fn(),
  mockBookerStillParticipates: vi.fn(),
  mockListByMeetingContexts: vi.fn(),
  mockListLiveByMeetingGuests: vi.fn(),
  mockResolveMeetingContextOwner: vi.fn(),
  mockDeliveringExpertUserId: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  clientPartyRecipientsRepository: {
    findMeetingBookerUserId: mockFindBooker,
    bookerStillParticipatesInCompany: mockBookerStillParticipates,
  },
  meetingContextsRepository: { listByMeeting: mockListByMeetingContexts },
  meetingGuestsRepository: { listLiveByMeeting: mockListLiveByMeetingGuests },
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
  mockBookerStillParticipates.mockResolvedValue(true);
});

describe('resolveCalendarPartyMemberUserIds — client', () => {
  const clientInput = {
    meetingId: MEETING_ID,
    party: 'client',
    expertProfileId: null,
  } as const;

  it('resolves the booker through the shared repository definition', async () => {
    mockFindBooker.mockResolvedValue('booker-1');

    const ids = await resolveCalendarPartyMemberUserIds(clientInput);

    expect(ids).toEqual(['booker-1']);
    expect(mockFindBooker).toHaveBeenCalledWith(MEETING_ID);
    // Pin the EXACT argument order: participation is checked against the OWNING company and the
    // BOOKER, never (say) the booker id for both.
    expect(mockBookerStillParticipates).toHaveBeenCalledWith('company-1', 'booker-1');
  });

  it('no resolvable booker (no audit row, or a NULL actor) ⇒ [] with no participation check', async () => {
    mockFindBooker.mockResolvedValue(null);

    await expect(resolveCalendarPartyMemberUserIds(clientInput)).resolves.toEqual([]);
    expect(mockBookerStillParticipates).not.toHaveBeenCalled();
  });

  it('a booker who no longer participates on the owning company ⇒ []', async () => {
    mockFindBooker.mockResolvedValue('booker-1');
    mockBookerStillParticipates.mockResolvedValue(false);

    await expect(resolveCalendarPartyMemberUserIds(clientInput)).resolves.toEqual([]);
  });

  it('no resolvable primary context ⇒ [] with no participation call', async () => {
    mockFindBooker.mockResolvedValue('booker-1');
    mockListByMeetingContexts.mockResolvedValue([]);

    await expect(resolveCalendarPartyMemberUserIds(clientInput)).resolves.toEqual([]);
    expect(mockBookerStillParticipates).not.toHaveBeenCalled();
  });

  it('an owner that does not resolve ⇒ [] with no participation call', async () => {
    mockFindBooker.mockResolvedValue('booker-1');
    mockResolveMeetingContextOwner.mockResolvedValue(undefined);

    await expect(resolveCalendarPartyMemberUserIds(clientInput)).resolves.toEqual([]);
    expect(mockBookerStillParticipates).not.toHaveBeenCalled();
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
    mockFindBooker.mockResolvedValue('booker-1');
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
