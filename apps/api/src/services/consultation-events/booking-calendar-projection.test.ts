import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';

const { mockResolveFacts, mockProjectToExpertCalendar } = vi.hoisted(() => ({
  mockResolveFacts: vi.fn(),
  mockProjectToExpertCalendar: vi.fn(),
}));

vi.mock('./resolve-calendar-facts.js', () => ({
  resolveExpertCalendarFacts: mockResolveFacts,
}));
vi.mock('./project-booking-to-calendar.js', () => ({
  projectBookingToExpertCalendar: mockProjectToExpertCalendar,
}));

const { projectBookingCalendarEvent } = await import('./booking-calendar-projection.js');

function fakeLog(): FastifyBaseLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as FastifyBaseLogger;
}

const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const CONTEXT_ID = '44444444-4444-4444-8444-444444444444';
const START = new Date('2026-09-07T09:00:00.000Z');
const END = new Date('2026-09-07T10:00:00.000Z');

const FACTS = {
  clientCompanyName: 'Northwind Industrial',
  title: 'CPQ rollout',
  eventLabel: 'Consultation',
};

/**
 * ⚠ `join_url` IS DELIBERATELY POPULATED WITH A RAW DAILY URL HERE. It is the value this
 * module must NEVER pass on — the assertion below is only meaningful because the wrong answer
 * is sitting right there on the row.
 */
function createdMeeting(
  expertProfileId: string | null = 'expert-1'
): Parameters<typeof projectBookingCalendarEvent>[0] {
  return {
    meeting: {
      id: MEETING_ID,
      scheduledStart: START,
      scheduledEnd: END,
      joinUrl: 'https://balo.daily.co/balo-0f7b1c2d3e4f4a5b8c9d0e1f2a3b4c5d',
    },
    contexts: [],
    expertProfileId,
  } as unknown as Parameters<typeof projectBookingCalendarEvent>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveFacts.mockResolvedValue(FACTS);
  mockProjectToExpertCalendar.mockResolvedValue('provider_event');
});

describe('projectBookingCalendarEvent — the happy path', () => {
  it('resolves facts for the given context and hands them to the expert-calendar writer', async () => {
    const log = fakeLog();

    await expect(
      projectBookingCalendarEvent(createdMeeting(), 'case', CONTEXT_ID, log)
    ).resolves.toBe('provider_event');

    expect(mockResolveFacts).toHaveBeenCalledWith('case', CONTEXT_ID, log);
    expect(mockProjectToExpertCalendar).toHaveBeenCalledTimes(1);
    const [[input]] = mockProjectToExpertCalendar.mock.calls;
    expect(input).toMatchObject({
      meetingId: MEETING_ID,
      expertProfileId: 'expert-1',
      clientCompanyName: 'Northwind Industrial',
      caseTitle: 'CPQ rollout',
      eventLabel: 'Consultation',
      startAt: START,
      endAt: END,
    });
  });

  /**
   * ⚠⚠ BALO'S MEMBER JOIN ROUTE, NEVER `meetings.join_url`. The raw Daily URL admits nobody
   * without a minted token and would read as a dead link months later; `/join/m/{id}` resolves
   * for every context and is the ONE action a calendar entry exists to enable (BAL-433 D4 —
   * no context backlink, because `/packages/…` does not exist and `/engagements/[id]` 404s a
   * case id).
   */
  it('⚠ builds the join URL from the MEMBER route and never from meetings.join_url', async () => {
    await projectBookingCalendarEvent(createdMeeting(), 'case', CONTEXT_ID, fakeLog());

    const [[input]] = mockProjectToExpertCalendar.mock.calls;
    const { joinUrl } = input as { joinUrl: string };
    expect(joinUrl).toBe(`${process.env.APP_URL ?? 'https://balo.expert'}/join/m/${MEETING_ID}`);
    expect(joinUrl).toContain(`/join/m/${MEETING_ID}`);
    expect(joinUrl).not.toContain('daily.co');
  });

  it('⚠ passes NO attendees and NO generateMeetingUrlProvider through the input', async () => {
    // ADR-1044 §4 / BAL-433 Ruling 2. `event-mapper.ts` asserts the absence at the payload;
    // this asserts it at the seam a future context could smuggle one in through.
    await projectBookingCalendarEvent(
      createdMeeting(),
      'request_interaction',
      CONTEXT_ID,
      fakeLog()
    );

    const [[input]] = mockProjectToExpertCalendar.mock.calls;
    expect(input).not.toHaveProperty('attendees');
    expect(input).not.toHaveProperty('generateMeetingUrlProvider');
  });

  it.each(['provider_event', 'ics', 'failed'] as const)(
    'reports the writer\'s own outcome "%s" verbatim',
    async (delivery) => {
      mockProjectToExpertCalendar.mockResolvedValue(delivery);

      await expect(
        projectBookingCalendarEvent(createdMeeting(), 'project_discovery', CONTEXT_ID, fakeLog())
      ).resolves.toBe(delivery);
    }
  );

  it.each([
    'case',
    'project_kickoff',
    'package_session',
    'project_discovery',
    'request_interaction',
  ] as const)(
    'projects contextType "%s" — every bookable label reaches the writer',
    async (contextType) => {
      await projectBookingCalendarEvent(createdMeeting(), contextType, CONTEXT_ID, fakeLog());

      expect(mockResolveFacts).toHaveBeenCalledWith(contextType, CONTEXT_ID, expect.anything());
      expect(mockProjectToExpertCalendar).toHaveBeenCalledTimes(1);
    }
  );
});

describe("projectBookingCalendarEvent — the 'skipped' branches", () => {
  /**
   * Structurally unreachable: a `match`-routed `project_discovery` cannot be booked at all
   * (`resolveMeetingExpertTx` throws `MatchModeDiscoveryNotBookableError` before commit), and
   * `CreatedMeeting` types this nullable only for `admin` meetings, which are not bookable.
   * ANSWERED rather than asserted away — and logged at `error`, because if it ever does happen
   * the booking committed with nobody to deliver it.
   */
  it('a null expertProfileId → "skipped" + log.error, and the writer is never reached', async () => {
    const log = fakeLog();

    await expect(
      projectBookingCalendarEvent(createdMeeting(null), 'project_discovery', CONTEXT_ID, log)
    ).resolves.toBe('skipped');

    expect(mockResolveFacts).not.toHaveBeenCalled();
    expect(mockProjectToExpertCalendar).not.toHaveBeenCalled();
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      { meetingId: MEETING_ID, contextType: 'project_discovery', contextId: CONTEXT_ID },
      'A booking resolved no expertProfileId — skipping the calendar projection'
    );
  });

  it('unresolved facts → "skipped", and the writer is never reached', async () => {
    // The fact resolver has already logged WHY (missing context, missing company, or a read
    // that threw). Re-logging here would double every one of those lines.
    mockResolveFacts.mockResolvedValue(undefined);
    const log = fakeLog();

    await expect(
      projectBookingCalendarEvent(createdMeeting(), 'case', CONTEXT_ID, log)
    ).resolves.toBe('skipped');

    expect(mockProjectToExpertCalendar).not.toHaveBeenCalled();
    expect(vi.mocked(log.error)).not.toHaveBeenCalled();
  });
});

describe('projectBookingCalendarEvent — it never rejects on its own callees', () => {
  it('a throwing fact resolver propagates nothing beyond its own contract', async () => {
    // ⚠ BOTH CALLEES CONTRACT TO "NEVER THROW" AND EACH OWNS A `try`/`catch`. This asserts the
    // COMPOSITION: if one of them ever violates that contract, the call site in
    // `provision-meeting.ts` still catches it (`projectBookingCalendarEventSafely`) — so a
    // committed booking can never be reported to the client as a failure.
    mockResolveFacts.mockRejectedValue(new Error('contract violated'));

    await expect(
      projectBookingCalendarEvent(createdMeeting(), 'case', CONTEXT_ID, fakeLog())
    ).rejects.toThrow('contract violated');
  });
});
