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

const { resolveCalendarInviteFacts, CalendarInviteFactsError } =
  await import('./resolve-calendar-invite-facts.js');

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

  // BAL-475 (follow-up, F32) — a THROWN read must now propagate (rejected), not degrade to
  // `undefined`. Swallowing it used to make the delivery job "succeed" with a terminal
  // `no_display_facts` skip on a transient DB error, permanently dropping the invite instead of
  // letting BullMQ retry (`attempts: 3`).
  it('a throwing read (listByMeeting) LOGS then RETHROWS a sanitised error — never the raw message', async () => {
    mockListByMeeting.mockRejectedValue(new Error('db blip: connection to 10.0.0.7:5432 refused'));
    const log = fakeLog();

    let caught: unknown;
    try {
      await resolveCalendarInviteFacts(
        { meetingId: MEETING_ID, party: 'expert', audience: 'member' },
        log
      );
      throw new Error('expected resolveCalendarInviteFacts to reject');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CalendarInviteFactsError);
    const message = (caught as Error).message;
    expect(message).toBe('Calendar invite display facts resolution failed: Error');
    expect(message).not.toContain('db blip');
    expect(message).not.toContain('10.0.0.7');

    // Still logged exactly as before: message + stack, same fields.
    expect(log.error).toHaveBeenCalledTimes(1);
    const [fields] = log.error.mock.calls[0] as [Record<string, unknown>];
    expect(fields.error).toContain('db blip');
    expect(fields.stack).toBeDefined();
  });

  it('a throwing read from a downstream call (deliveringPartyName, client party) also rethrows sanitised', async () => {
    mockDeliveringPartyName.mockRejectedValue(new Error('agency lookup blew up'));

    await expect(
      resolveCalendarInviteFacts(
        { meetingId: MEETING_ID, party: 'client', audience: 'member' },
        fakeLog()
      )
    ).rejects.toBeInstanceOf(CalendarInviteFactsError);
  });

  it('genuine domain absence paths still resolve to undefined and do NOT throw (no primary context, non-bookable context, undefined expert facts)', async () => {
    const log = fakeLog();

    mockListByMeeting.mockResolvedValue([]);
    await expect(
      resolveCalendarInviteFacts(
        { meetingId: MEETING_ID, party: 'expert', audience: 'member' },
        log
      )
    ).resolves.toBeUndefined();

    mockListByMeeting.mockResolvedValue([{ contextType: 'retainer_checkin', contextId: 'ctx-1' }]);
    await expect(
      resolveCalendarInviteFacts(
        { meetingId: MEETING_ID, party: 'expert', audience: 'member' },
        log
      )
    ).resolves.toBeUndefined();

    mockListByMeeting.mockResolvedValue(CASE_CONTEXT);
    mockResolveExpertCalendarFacts.mockResolvedValue(undefined);
    await expect(
      resolveCalendarInviteFacts(
        { meetingId: MEETING_ID, party: 'expert', audience: 'member' },
        log
      )
    ).resolves.toBeUndefined();
  });
});
