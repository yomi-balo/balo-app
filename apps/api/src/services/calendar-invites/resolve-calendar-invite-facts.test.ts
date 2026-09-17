import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockListByMeeting,
  mockResolveExpertCalendarFacts,
  mockDeliveringExpertProfileIdForMeeting,
  mockDeliveringPartyName,
} = vi.hoisted(() => ({
  mockListByMeeting: vi.fn(),
  mockResolveExpertCalendarFacts: vi.fn(),
  mockDeliveringExpertProfileIdForMeeting: vi.fn(),
  mockDeliveringPartyName: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  meetingContextsRepository: { listByMeeting: mockListByMeeting },
}));
vi.mock('../consultation-events/resolve-calendar-facts.js', () => ({
  resolveExpertCalendarFacts: mockResolveExpertCalendarFacts,
}));
vi.mock('../meetings/delivering-party.js', () => ({
  deliveringExpertProfileIdForMeeting: mockDeliveringExpertProfileIdForMeeting,
  deliveringPartyName: mockDeliveringPartyName,
}));

const { resolveCalendarInviteFacts } = await import('./resolve-calendar-invite-facts.js');

function fakeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const MEETING_ID = 'meeting-1';
const CASE_CONTEXT = [{ contextType: 'case' as const, contextId: 'ctx-1' }];

const FACTS = {
  clientCompanyName: 'Northwind Industrial',
  title: 'CPQ rollout',
  eventLabel: 'Consultation',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockListByMeeting.mockResolvedValue(CASE_CONTEXT);
  mockResolveExpertCalendarFacts.mockResolvedValue(FACTS);
  mockDeliveringExpertProfileIdForMeeting.mockResolvedValue('expert-profile-1');
  mockDeliveringPartyName.mockResolvedValue('CloudPeak');
});

describe('resolveCalendarInviteFacts', () => {
  it('expert party, member audience: summary names the client COMPANY; location + memberJoinUrl set', async () => {
    const facts = await resolveCalendarInviteFacts(
      { meetingId: MEETING_ID, party: 'expert', audience: 'member' },
      fakeLog()
    );

    expect(facts?.summary).toBe('Consultation with Northwind Industrial');
    expect(facts?.location).toContain('/join/m/meeting-1');
    expect(facts?.memberJoinUrl).toBe(facts?.location);
    expect(facts?.description).toContain('Join:');
  });

  it('client party, member audience: summary names the delivering PARTY (agency)', async () => {
    const facts = await resolveCalendarInviteFacts(
      { meetingId: MEETING_ID, party: 'client', audience: 'member' },
      fakeLog()
    );

    expect(facts?.summary).toBe('Consultation with CloudPeak');
  });

  it('client party: an independent expert (deliveringPartyName resolves the person) is named directly', async () => {
    mockDeliveringPartyName.mockResolvedValue('Dana Okoro');

    const facts = await resolveCalendarInviteFacts(
      { meetingId: MEETING_ID, party: 'client', audience: 'member' },
      fakeLog()
    );

    expect(facts?.summary).toBe('Consultation with Dana Okoro');
  });

  it('client party: a null deliveringPartyName degrades to "your expert"', async () => {
    mockDeliveringPartyName.mockResolvedValue(null);

    const facts = await resolveCalendarInviteFacts(
      { meetingId: MEETING_ID, party: 'client', audience: 'member' },
      fakeLog()
    );

    expect(facts?.summary).toBe('Consultation with your expert');
  });

  it('guest audience: no join link, no location, no memberJoinUrl, and no http substring', async () => {
    const facts = await resolveCalendarInviteFacts(
      { meetingId: MEETING_ID, party: 'expert', audience: 'guest' },
      fakeLog()
    );

    expect(facts?.location).toBeUndefined();
    expect(facts?.memberJoinUrl).toBeUndefined();
    expect(facts?.description).not.toContain('http');
  });

  it('member audience description carries the join URL and the changes note', async () => {
    const facts = await resolveCalendarInviteFacts(
      { meetingId: MEETING_ID, party: 'expert', audience: 'member' },
      fakeLog()
    );

    expect(facts?.description).toContain('CPQ rollout');
    expect(facts?.description).toContain('Rescheduling and cancelling happen in Balo');
  });

  it('no primary context (none) ⇒ undefined', async () => {
    mockListByMeeting.mockResolvedValue([]);

    const facts = await resolveCalendarInviteFacts(
      { meetingId: MEETING_ID, party: 'expert', audience: 'member' },
      fakeLog()
    );

    expect(facts).toBeUndefined();
  });

  it('ambiguous primary context ⇒ undefined', async () => {
    mockListByMeeting.mockResolvedValue([
      { contextType: 'case', contextId: 'ctx-1' },
      { contextType: 'case', contextId: 'ctx-2' },
    ]);

    const facts = await resolveCalendarInviteFacts(
      { meetingId: MEETING_ID, party: 'expert', audience: 'member' },
      fakeLog()
    );

    expect(facts).toBeUndefined();
  });

  it('a non-bookable primary context (no calendar descriptor) ⇒ undefined + log.warn', async () => {
    mockListByMeeting.mockResolvedValue([{ contextType: 'retainer_checkin', contextId: 'ctx-1' }]);
    const log = fakeLog();

    const facts = await resolveCalendarInviteFacts(
      { meetingId: MEETING_ID, party: 'expert', audience: 'member' },
      log
    );

    expect(facts).toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });

  it('undefined facts from the context resolver ⇒ undefined', async () => {
    mockResolveExpertCalendarFacts.mockResolvedValue(undefined);

    const facts = await resolveCalendarInviteFacts(
      { meetingId: MEETING_ID, party: 'expert', audience: 'member' },
      fakeLog()
    );

    expect(facts).toBeUndefined();
  });

  it('a throwing read degrades to undefined + log.error, never throws', async () => {
    mockListByMeeting.mockRejectedValue(new Error('db blip'));
    const log = fakeLog();

    await expect(
      resolveCalendarInviteFacts(
        { meetingId: MEETING_ID, party: 'expert', audience: 'member' },
        log
      )
    ).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalled();
  });
});
