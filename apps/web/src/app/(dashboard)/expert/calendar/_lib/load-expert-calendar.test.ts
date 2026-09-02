import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ExpertCalendarMeeting } from '@balo/db';

/**
 * BAL-498 fix round 1 — B2/B3/B7. THE REGRESSION THIS FILE EXISTS TO CATCH:
 *
 *   B2/B3: the query range used to be built by pasting a LOCAL day key into a UTC instant
 *   (`new Date(\`\${dayKey}T00:00:00.000Z\`)`). For a zone EAST of UTC that starts the window
 *   8-14h after local midnight, silently dropping real meetings from the result. Every test
 *   below runs in `Australia/Sydney` (UTC+10/+11) specifically because a UTC-only suite cannot
 *   see this bug — it would pass against both the broken and the fixed implementation.
 *
 *   B7: `href` must be `null` whenever the repository could not verify the owning row
 *   (`owningRowFound: false`), for ALL FOUR context arms — not only `request_interaction`.
 *
 * BAL-513: the single stretched `weekStart -> max(weekStart+28, today+28)` range became TWO
 * bounded windows — the visible week (7 days) and the Agenda horizon (today + 28 days) — issued
 * together via `Promise.all` (week first, agenda second) and merged. Every test that pins
 * `listCalendarForExpert`'s call args now reads `mock.calls[0]` for the week window and
 * `mock.calls[1]` for the agenda window.
 */

vi.mock('server-only', () => ({}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, cache: <T>(fn: T): T => fn };
});

const m = {
  listCalendarForExpert: vi.fn(),
  findTimezone: vi.fn(),
};

vi.mock('@balo/db', () => ({
  meetingsRepository: { listCalendarForExpert: (...a: unknown[]) => m.listCalendarForExpert(...a) },
  expertsRepository: { findTimezone: (...a: unknown[]) => m.findTimezone(...a) },
}));

/**
 * Kept in step with `MAX_CALENDAR_RANGE_DAYS` in `packages/db/src/repositories/meetings.ts` — the
 * repository REFUSES a wider range (S2), so a loader change that widened a window past this would
 * take the page from "renders" to "throws". Duplicated as a literal deliberately: importing it
 * would come through the `@balo/db` mock above and assert nothing — and even spreading the mock
 * over the REAL module (`importOriginal`) does not help, because `MAX_CALENDAR_RANGE_DAYS` is not
 * part of `@balo/db`'s public surface (`packages/db/src/repositories/index.ts` hand-picks its
 * re-exports from `./meetings` and deliberately omits it; `package.json`'s `exports` map exposes
 * only `.` and `./schema`). Confirmed empirically (BAL-513 fix round 1, F3): a value import of
 * `@balo/db` does NOT crash the web vitest project the way it can crash a `next build` on `tls` —
 * `importOriginal()` here loaded the real module cleanly — the import just fails because the
 * export genuinely does not exist. The invariant this constant must satisfy
 * (`MAX_CALENDAR_RANGE_DAYS >= AGENDA_HORIZON_DAYS`) is pinned instead on the `packages/db` side —
 * see `MAX_CALENDAR_RANGE_DAYS >= 31` in `packages/db/src/repositories/meetings.test.ts`.
 */
const MAX_CALENDAR_RANGE_DAYS = 35;

const { mockLog } = vi.hoisted(() => ({
  mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/logging', () => ({ log: mockLog }));

const mockGetChecklistStatus = vi.fn();
vi.mock('@/lib/actions/expert-checklist', () => ({
  getChecklistStatus: () => mockGetChecklistStatus(),
}));

const EXPERT_PROFILE_ID = 'p0000000-0000-4000-8000-000000000001';
/** The SESSION's user id — S3 threads it into the scoped `findTimezone` read. */
const USER_ID = 'u0000000-0000-4000-8000-000000000009';

// "Today" is pinned because window (b) (the Agenda horizon) is ANCHORED ON TODAY, independently
// of the visible week — BAL-513 replaced the N5 forward-clamp with this second, always-fetched
// window. 2026-08-20 is a Thursday; the CURRENT week's Monday is 2026-08-17.
const FIXED_TODAY = new Date('2026-08-20T00:00:00.000Z'); // 2026-08-20 10:00 AEST

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_TODAY);
});

afterEach(() => {
  vi.useRealTimers();
});

function baseMeeting(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    meetingId: 'm1',
    scheduledStart: new Date('2026-08-23T23:15:00.000Z'),
    scheduledEnd: new Date('2026-08-23T23:45:00.000Z'),
    status: 'scheduled',
    contextType: 'case',
    contextId: 'engagement-1',
    engagementType: 'case',
    projectRequestId: null,
    counterpartyCompanyName: 'Northwind',
    owningRowFound: true,
    ...overrides,
  };
}

type CallArgs = [{ rangeStart: Date; rangeEnd: Date }];

function weekCall(): { rangeStart: Date; rangeEnd: Date } {
  const [call] = m.listCalendarForExpert.mock.calls as CallArgs[];
  if (call === undefined)
    throw new Error('listCalendarForExpert was not called for the week window');
  const [args] = call;
  return args;
}

function agendaCall(): { rangeStart: Date; rangeEnd: Date } {
  const calls = m.listCalendarForExpert.mock.calls as CallArgs[];
  const call = calls[1];
  if (call === undefined)
    throw new Error('listCalendarForExpert was not called for the agenda window');
  const [args] = call;
  return args;
}

describe('loadExpertCalendar — query range timezone correctness (B2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.findTimezone.mockResolvedValue('Australia/Sydney');
    m.listCalendarForExpert.mockResolvedValue([]);
    mockGetChecklistStatus.mockResolvedValue({ items: { calendar: true } });
  });

  it('converts the LOCAL day key through the expert’s OWN zone, not a bare UTC-literal parse', async () => {
    const { loadExpertCalendar } = await import('./load-expert-calendar');

    // Monday 2026-08-24 00:00 AEST (UTC+10) is 2026-08-23T14:00:00Z — NOT
    // 2026-08-24T00:00:00Z, which is what the pre-fix `...T00:00:00.000Z` parse produced.
    await loadExpertCalendar({
      expertProfileId: EXPERT_PROFILE_ID,
      userId: USER_ID,
      weekStartDayKey: '2026-08-24',
    });

    // Two bounded reads since BAL-513: the visible week and the Agenda horizon.
    expect(m.listCalendarForExpert).toHaveBeenCalledTimes(2);
    const { rangeStart, rangeEnd } = weekCall();

    expect(rangeStart.toISOString()).toBe('2026-08-23T14:00:00.000Z');
    // weekStart + WEEK_DAYS (7), same local-midnight anchor.
    expect(rangeEnd.toISOString()).toBe('2026-08-30T14:00:00.000Z');
  });

  it('a Monday-morning AEST meeting that the BROKEN UTC-literal range would have dropped is INSIDE the fixed range', async () => {
    // The exact failure scenario from the security/review verdicts: a Mon 09:00-09:30 AEST
    // case is 2026-08-23T23:00Z-23:30Z. The broken `rangeStart = 2026-08-24T00:00Z` excludes it
    // (`endAt 23:30Z` is NOT `> rangeStart 00:00Z`). The fixed `rangeStart` (computed above,
    // 2026-08-23T14:00:00.000Z) is hours BEFORE it, so the repository call receives a range that
    // actually contains this meeting.
    const meetingEnd = new Date('2026-08-23T23:30:00.000Z');
    const { loadExpertCalendar } = await import('./load-expert-calendar');

    await loadExpertCalendar({
      expertProfileId: EXPERT_PROFILE_ID,
      userId: USER_ID,
      weekStartDayKey: '2026-08-24',
    });

    const { rangeStart, rangeEnd } = weekCall();
    expect(rangeStart.getTime()).toBeLessThan(meetingEnd.getTime());
    expect(rangeEnd.getTime()).toBeGreaterThan(meetingEnd.getTime());
  });

  it('scopes the expert_profiles read to the SESSION user id (S3) — a bare by-id read on an RLS-less table is not enough', async () => {
    const { loadExpertCalendar } = await import('./load-expert-calendar');

    await loadExpertCalendar({
      expertProfileId: EXPERT_PROFILE_ID,
      userId: USER_ID,
      weekStartDayKey: '2026-08-24',
    });

    // The regression this pins: dropping the second argument turns this back into a bare by-id
    // read on a table with no RLS, exactly the containment gap `expertSearchabilityRepository
    // .loadInputs`'s S4 overload already closes for its sibling call in this same loader.
    expect(m.findTimezone).toHaveBeenCalledWith(EXPERT_PROFILE_ID, { userId: USER_ID });
  });

  it('falls back to UTC and logs when findTimezone resolves null, but still resolves a valid range', async () => {
    m.findTimezone.mockResolvedValue(null);
    const { loadExpertCalendar } = await import('./load-expert-calendar');

    const view = await loadExpertCalendar({
      expertProfileId: EXPERT_PROFILE_ID,
      userId: USER_ID,
      weekStartDayKey: '2026-08-24',
    });

    expect(view.timezone).toBe('UTC');
    const { rangeStart } = weekCall();
    expect(rangeStart.toISOString()).toBe('2026-08-24T00:00:00.000Z');
  });
});

describe('loadExpertCalendar — href fails closed with owningRowFound (B7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.findTimezone.mockResolvedValue('Australia/Sydney');
    mockGetChecklistStatus.mockResolvedValue({ items: { calendar: true } });
  });

  it('a case meeting with owningRowFound=false gets href: null, even though contextId is populated', async () => {
    m.listCalendarForExpert.mockResolvedValue([
      baseMeeting({
        contextType: 'case',
        contextId: 'someone-elses-engagement',
        owningRowFound: false,
      }),
    ]);
    const { loadExpertCalendar } = await import('./load-expert-calendar');

    const view = await loadExpertCalendar({
      expertProfileId: EXPERT_PROFILE_ID,
      userId: USER_ID,
      weekStartDayKey: '2026-08-24',
    });

    expect(view.meetings[0]?.href).toBeNull();
  });

  it('a project_kickoff meeting with owningRowFound=false gets href: null', async () => {
    m.listCalendarForExpert.mockResolvedValue([
      baseMeeting({ contextType: 'project_kickoff', contextId: 'drifted', owningRowFound: false }),
    ]);
    const { loadExpertCalendar } = await import('./load-expert-calendar');

    const view = await loadExpertCalendar({
      expertProfileId: EXPERT_PROFILE_ID,
      userId: USER_ID,
      weekStartDayKey: '2026-08-24',
    });

    expect(view.meetings[0]?.href).toBeNull();
  });

  it('a project_discovery meeting with owningRowFound=false gets href: null EVEN THOUGH contextId IS the request id', async () => {
    // The exact gap security-bal-498.md named: project_discovery's contextId already equals the
    // request id, so a naive fix reaching for contextId would still render a link here.
    m.listCalendarForExpert.mockResolvedValue([
      baseMeeting({
        contextType: 'project_discovery',
        contextId: 'request-that-looks-valid',
        projectRequestId: null,
        owningRowFound: false,
      }),
    ]);
    const { loadExpertCalendar } = await import('./load-expert-calendar');

    const view = await loadExpertCalendar({
      expertProfileId: EXPERT_PROFILE_ID,
      userId: USER_ID,
      weekStartDayKey: '2026-08-24',
    });

    expect(view.meetings[0]?.href).toBeNull();
  });

  it('a case meeting with owningRowFound=true renders the expected href', async () => {
    m.listCalendarForExpert.mockResolvedValue([baseMeeting()]);
    const { loadExpertCalendar } = await import('./load-expert-calendar');

    const view = await loadExpertCalendar({
      expertProfileId: EXPERT_PROFILE_ID,
      userId: USER_ID,
      weekStartDayKey: '2026-08-24',
    });

    expect(view.meetings[0]?.href).toBe('/cases/engagement-1');
  });

  it('a request_interaction meeting resolves href from the VERIFIED projectRequestId, not contextId', async () => {
    m.listCalendarForExpert.mockResolvedValue([
      baseMeeting({
        contextType: 'request_interaction',
        contextId: 'relationship-1',
        projectRequestId: 'request-9',
        owningRowFound: true,
      }),
    ]);
    const { loadExpertCalendar } = await import('./load-expert-calendar');

    const view = await loadExpertCalendar({
      expertProfileId: EXPERT_PROFILE_ID,
      userId: USER_ID,
      weekStartDayKey: '2026-08-24',
    });

    expect(view.meetings[0]?.href).toBe('/projects/request-9');
  });
});

describe('loadExpertCalendar — two bounded windows replace the single stretched range (BAL-513 C1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.findTimezone.mockResolvedValue('Australia/Sydney');
    m.listCalendarForExpert.mockResolvedValue([]);
    mockGetChecklistStatus.mockResolvedValue({ items: { calendar: true } });
  });

  it('a far-past visible week fetches the Agenda horizon as its OWN window, not by stretching the week’s', async () => {
    const { loadExpertCalendar } = await import('./load-expert-calendar');

    // Paging back to a week in January while "today" (faked) is 2026-08-20. Pre-BAL-513 this
    // stretched ONE query's rangeEnd forward to today+28; now the Agenda horizon is its own,
    // always-issued second read, anchored on today regardless of the visible week.
    await loadExpertCalendar({
      expertProfileId: EXPERT_PROFILE_ID,
      userId: USER_ID,
      weekStartDayKey: '2026-01-05',
    });

    expect(m.listCalendarForExpert).toHaveBeenCalledTimes(2);
    const week = weekCall();
    const agenda = agendaCall();

    expect(week.rangeStart.toISOString()).toBe('2026-01-04T13:00:00.000Z');
    expect(week.rangeEnd.toISOString()).toBe('2026-01-11T13:00:00.000Z');
    expect(agenda.rangeStart.toISOString()).toBe('2026-08-19T14:00:00.000Z');
    expect(agenda.rangeEnd.toISOString()).toBe('2026-09-16T14:00:00.000Z');

    // The surviving N5 intent: "today" falls strictly inside the AGENDA window, so a call
    // happening today is still returned even though the visible week is months away.
    expect(agenda.rangeStart.getTime()).toBeLessThanOrEqual(FIXED_TODAY.getTime());
    expect(agenda.rangeEnd.getTime()).toBeGreaterThan(FIXED_TODAY.getTime());
  });

  it('the WIDEST week the page will accept still produces two windows inside the repository’s maximum span (S2)', async () => {
    const { loadExpertCalendar } = await import('./load-expert-calendar');

    // `page.tsx` bounds `?week=` to ±365 days of today and `weekStartDayKey` can round back a
    // further 6, so this is the furthest-past week that can ever reach the loader from a real
    // request: today (2026-08-20) − 371 days.
    await loadExpertCalendar({
      expertProfileId: EXPERT_PROFILE_ID,
      userId: USER_ID,
      weekStartDayKey: '2025-08-14',
    });

    expect(m.listCalendarForExpert).toHaveBeenCalledTimes(2);
    const week = weekCall();
    const agenda = agendaCall();

    const weekSpanDays = (week.rangeEnd.getTime() - week.rangeStart.getTime()) / 86_400_000;
    const agendaSpanDays = (agenda.rangeEnd.getTime() - agenda.rangeStart.getTime()) / 86_400_000;

    // ±1h DST tolerance, never the ~399-day span the old single-window clamp could produce.
    expect(weekSpanDays).toBeGreaterThan(6.9);
    expect(weekSpanDays).toBeLessThan(7.1);
    expect(agendaSpanDays).toBeGreaterThan(27.9);
    expect(agendaSpanDays).toBeLessThan(28.1);

    expect(weekSpanDays).toBeLessThanOrEqual(MAX_CALENDAR_RANGE_DAYS);
    expect(agendaSpanDays).toBeLessThanOrEqual(MAX_CALENDAR_RANGE_DAYS);
    // The assertion that INVERTS the pre-BAL-513 `toBeGreaterThan(390)`: neither window ever
    // approaches, let alone exceeds, the repository's maximum.
    expect(weekSpanDays).toBeLessThan(MAX_CALENDAR_RANGE_DAYS);
    expect(agendaSpanDays).toBeLessThan(MAX_CALENDAR_RANGE_DAYS);
  });

  it('a forward-paged week ALSO fetches today’s near-term Agenda content (D9/M4 — a deliberate, tested behaviour change)', async () => {
    const { loadExpertCalendar } = await import('./load-expert-calendar');

    // weekStart is ~60 days ahead of "today". Pre-BAL-513 the single window started at
    // `weekStart`, so Agenda's `dayKey >= today` filter had nothing between today and the paged
    // week to show. Now the Agenda horizon is ALWAYS fetched, so it does.
    await loadExpertCalendar({
      expertProfileId: EXPERT_PROFILE_ID,
      userId: USER_ID,
      weekStartDayKey: '2026-10-19',
    });

    expect(m.listCalendarForExpert).toHaveBeenCalledTimes(2);
    const week = weekCall();
    const agenda = agendaCall();

    // weekStart(2026-10-19) + 7d = 2026-10-26 local. Daylight saving starts 2026-10-04 in
    // Sydney, so this local midnight is AEDT (+11).
    expect(week.rangeStart.toISOString()).toBe('2026-10-18T13:00:00.000Z');
    expect(week.rangeEnd.toISOString()).toBe('2026-10-25T13:00:00.000Z');
    // The agenda window is UNCHANGED by how far forward the visible week is paged — it always
    // covers today's near term, which the pre-BAL-513 single window did not reach at all here.
    expect(agenda.rangeStart.toISOString()).toBe('2026-08-19T14:00:00.000Z');
    expect(agenda.rangeEnd.toISOString()).toBe('2026-09-16T14:00:00.000Z');
  });

  it('issues the visible-week window FIRST and the Agenda horizon SECOND', async () => {
    const { loadExpertCalendar } = await import('./load-expert-calendar');

    await loadExpertCalendar({
      expertProfileId: EXPERT_PROFILE_ID,
      userId: USER_ID,
      weekStartDayKey: '2026-08-24',
    });

    const week = weekCall();
    const agenda = agendaCall();
    const weekSpanDays = (week.rangeEnd.getTime() - week.rangeStart.getTime()) / 86_400_000;
    const agendaSpanDays = (agenda.rangeEnd.getTime() - agenda.rangeStart.getTime()) / 86_400_000;

    expect(week.rangeStart.toISOString()).toBe('2026-08-23T14:00:00.000Z');
    expect(weekSpanDays).toBeCloseTo(7, 1);
    expect(agendaSpanDays).toBeCloseTo(28, 1);
  });

  it('returns each meeting ONCE when the two windows overlap (AC3)', async () => {
    const meetingA = baseMeeting({
      meetingId: 'A',
      scheduledStart: new Date('2026-08-19T23:00:00.000Z'),
      scheduledEnd: new Date('2026-08-19T23:30:00.000Z'),
    });
    const meetingB = baseMeeting({
      meetingId: 'B',
      scheduledStart: new Date('2026-08-20T23:00:00.000Z'),
      scheduledEnd: new Date('2026-08-20T23:30:00.000Z'),
    });
    const meetingC = baseMeeting({
      meetingId: 'C',
      scheduledStart: new Date('2026-09-01T23:00:00.000Z'),
      scheduledEnd: new Date('2026-09-01T23:30:00.000Z'),
    });
    m.listCalendarForExpert
      .mockResolvedValueOnce([meetingA, meetingB])
      .mockResolvedValueOnce([meetingB, meetingC]);
    const { loadExpertCalendar } = await import('./load-expert-calendar');

    const view = await loadExpertCalendar({
      expertProfileId: EXPERT_PROFILE_ID,
      userId: USER_ID,
      weekStartDayKey: '2026-08-17',
    });

    const ids = view.meetings.map((meeting) => meeting.meetingId);
    expect(ids).toHaveLength(3);
    expect(new Set(ids)).toEqual(new Set(['A', 'B', 'C']));
  });

  it('re-sorts the merged set — a FORWARD-paged week’s meetings do not jump ahead of the agenda horizon’s (D7)', async () => {
    const weekMeeting = baseMeeting({
      meetingId: 'w1',
      scheduledStart: new Date('2026-10-20T00:00:00.000Z'),
      scheduledEnd: new Date('2026-10-20T00:30:00.000Z'),
    });
    const agendaMeeting = baseMeeting({
      meetingId: 'a1',
      scheduledStart: new Date('2026-08-25T00:00:00.000Z'),
      scheduledEnd: new Date('2026-08-25T00:30:00.000Z'),
    });
    m.listCalendarForExpert
      .mockResolvedValueOnce([weekMeeting])
      .mockResolvedValueOnce([agendaMeeting]);
    const { loadExpertCalendar } = await import('./load-expert-calendar');

    const view = await loadExpertCalendar({
      expertProfileId: EXPERT_PROFILE_ID,
      userId: USER_ID,
      weekStartDayKey: '2026-10-19',
    });

    // Fails on naive concatenation, which would yield ['w1', 'a1'].
    expect(view.meetings.map((meeting) => meeting.meetingId)).toEqual(['a1', 'w1']);
  });

  it('re-sorts the merged set across an INTERLEAVED current week (D7)', async () => {
    const mMon = baseMeeting({
      meetingId: 'm-mon',
      scheduledStart: new Date('2026-08-17T00:00:00.000Z'),
      scheduledEnd: new Date('2026-08-17T00:30:00.000Z'),
    });
    const mFri = baseMeeting({
      meetingId: 'm-fri',
      scheduledStart: new Date('2026-08-21T00:00:00.000Z'),
      scheduledEnd: new Date('2026-08-21T00:30:00.000Z'),
    });
    const mThu = baseMeeting({
      meetingId: 'm-thu',
      scheduledStart: new Date('2026-08-20T00:00:00.000Z'),
      scheduledEnd: new Date('2026-08-20T00:30:00.000Z'),
    });
    const mTue = baseMeeting({
      meetingId: 'm-tue',
      scheduledStart: new Date('2026-08-25T00:00:00.000Z'),
      scheduledEnd: new Date('2026-08-25T00:30:00.000Z'),
    });
    m.listCalendarForExpert
      .mockResolvedValueOnce([mMon, mFri])
      .mockResolvedValueOnce([mThu, mFri, mTue]);
    const { loadExpertCalendar } = await import('./load-expert-calendar');

    const view = await loadExpertCalendar({
      expertProfileId: EXPERT_PROFILE_ID,
      userId: USER_ID,
      weekStartDayKey: '2026-08-17',
    });

    // Order AND dedupe in one: `m-fri` appears in both windows but survives once.
    expect(view.meetings.map((meeting) => meeting.meetingId)).toEqual([
      'm-mon',
      'm-thu',
      'm-fri',
      'm-tue',
    ]);
  });

  it('a week straddling the DST changeover stays inside the repository’s maximum span', async () => {
    const { loadExpertCalendar } = await import('./load-expert-calendar');

    // Sydney's AEST -> AEDT changeover is 2026-10-04.
    await loadExpertCalendar({
      expertProfileId: EXPERT_PROFILE_ID,
      userId: USER_ID,
      weekStartDayKey: '2026-09-28',
    });

    const week = weekCall();
    const weekSpanDays = (week.rangeEnd.getTime() - week.rangeStart.getTime()) / 86_400_000;

    // 6 days 23 hours, not exactly 7.
    expect(weekSpanDays).toBeLessThan(7);
    expect(weekSpanDays).toBeGreaterThan(6.9);
    expect(weekSpanDays).toBeLessThanOrEqual(MAX_CALENDAR_RANGE_DAYS);
  });

  it('a meeting starting on the Sunday BEFORE the visible Monday survives into the view (AC3, loader half)', async () => {
    // Sun 2026-08-16 23:45 Sydney -> Mon 2026-08-17 00:15 Sydney, i.e. 2026-08-16T13:45Z -
    // 2026-08-16T14:15Z. The loader adds no client-side date filtering of its own — the
    // repository's overlap predicate already returns it inside the week window.
    const sundayCrossing = baseMeeting({
      meetingId: 'sunday-crossing',
      scheduledStart: new Date('2026-08-16T13:45:00.000Z'),
      scheduledEnd: new Date('2026-08-16T14:15:00.000Z'),
    });
    m.listCalendarForExpert.mockResolvedValueOnce([sundayCrossing]).mockResolvedValueOnce([]);
    const { loadExpertCalendar } = await import('./load-expert-calendar');

    const view = await loadExpertCalendar({
      expertProfileId: EXPERT_PROFILE_ID,
      userId: USER_ID,
      weekStartDayKey: '2026-08-17',
    });

    expect(view.meetings.map((meeting) => meeting.meetingId)).toContain('sunday-crossing');
  });

  it.each(['scheduled', 'waiting_for_participants', 'in_progress', 'ended'] as const)(
    'maps meeting status %s through to the view (C2.4)',
    async (status) => {
      m.listCalendarForExpert
        .mockResolvedValueOnce([baseMeeting({ status })])
        .mockResolvedValueOnce([]);
      const { loadExpertCalendar } = await import('./load-expert-calendar');

      const view = await loadExpertCalendar({
        expertProfileId: EXPERT_PROFILE_ID,
        userId: USER_ID,
        weekStartDayKey: '2026-08-24',
      });

      expect(view.meetings[0]?.status).toBe(status);
    }
  );

  it('logs the FAILING window with its bounds and re-throws (D8)', async () => {
    const boom = new Error('boom');
    m.listCalendarForExpert
      .mockResolvedValueOnce([]) // week
      .mockRejectedValueOnce(boom); // agenda
    const { loadExpertCalendar } = await import('./load-expert-calendar');

    await expect(
      loadExpertCalendar({
        expertProfileId: EXPERT_PROFILE_ID,
        userId: USER_ID,
        weekStartDayKey: '2026-08-24',
      })
    ).rejects.toThrow('boom');

    expect(mockLog.error).toHaveBeenCalledWith(
      'Expert calendar window read failed',
      expect.objectContaining({
        window: 'agenda',
        expertProfileId: EXPERT_PROFILE_ID,
        rangeStart: expect.any(String),
        rangeEnd: expect.any(String),
        error: 'boom',
      })
    );
  });
});

describe('mergeCalendarWindows — the exported merge/dedupe/sort primitive (D7)', () => {
  it('merges to a stable order regardless of which window a duplicate came from, tie-broken by meetingId', async () => {
    const { mergeCalendarWindows } = await import('./load-expert-calendar');

    const sameInstant = new Date('2026-08-20T00:00:00.000Z');
    function calendarMeeting(meetingId: string): ExpertCalendarMeeting {
      return {
        meetingId,
        scheduledStart: sameInstant,
        scheduledEnd: sameInstant,
        status: 'scheduled',
        contextType: 'case',
        contextId: 'engagement-1',
        engagementType: 'case',
        projectRequestId: null,
        counterpartyCompanyName: 'Northwind',
        owningRowFound: true,
      };
    }
    const zMeeting = calendarMeeting('z');
    const aMeeting = calendarMeeting('a');

    const merged = mergeCalendarWindows([zMeeting], [aMeeting, zMeeting]);

    expect(merged.map((meeting) => meeting.meetingId)).toEqual(['a', 'z']);
    // First writer wins on a duplicate: exactly one 'z' survives.
    expect(merged.filter((meeting) => meeting.meetingId === 'z')).toHaveLength(1);
  });
});
