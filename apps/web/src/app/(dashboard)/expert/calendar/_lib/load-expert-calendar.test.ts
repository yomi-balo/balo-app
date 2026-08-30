import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
 * repository REFUSES a wider range (S2), so a loader change that widened the window past this
 * would take the page from "renders" to "throws". Duplicated as a literal deliberately: importing
 * it would come through the `@balo/db` mock above and assert nothing.
 */
const MAX_CALENDAR_RANGE_DAYS = 420;

const mockGetChecklistStatus = vi.fn();
vi.mock('@/lib/actions/expert-checklist', () => ({
  getChecklistStatus: () => mockGetChecklistStatus(),
}));

const EXPERT_PROFILE_ID = 'p0000000-0000-4000-8000-000000000001';
/** The SESSION's user id — S3 threads it into the scoped `findTimezone` read. */
const USER_ID = 'u0000000-0000-4000-8000-000000000009';

// Every existing test in this file pins its range assertions against `weekStartDayKey`
// `'2026-08-24'` alone, with no dependency on the real clock — that stopped being true the
// moment N5's fix (below) made `rangeEnd` also depend on "today". Pin "today" to a date BEFORE
// 2026-08-24 (Sydney) so every pre-existing assertion keeps holding regardless of when this
// suite actually runs: `agendaHorizonEndDayKey` (today+28) then falls short of
// `weekRangeEndDayKey` (weekStart+28) in every "forward" test below, leaving `rangeEnd`
// unchanged from its pre-N5 value.
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

    expect(m.listCalendarForExpert).toHaveBeenCalledTimes(1);
    const calls = m.listCalendarForExpert.mock.calls as [{ rangeStart: Date; rangeEnd: Date }][];
    const [call] = calls;
    if (call === undefined) throw new Error('listCalendarForExpert was not called');
    const [{ rangeStart, rangeEnd }] = call;

    expect(rangeStart.toISOString()).toBe('2026-08-23T14:00:00.000Z');
    // 7 (week) + 21 (agenda padding) = 28 days after the week start, same local-midnight anchor.
    expect(rangeEnd.toISOString()).toBe('2026-09-20T14:00:00.000Z');
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

    const [{ rangeStart, rangeEnd }] = m.listCalendarForExpert.mock.calls[0] as [
      { rangeStart: Date; rangeEnd: Date },
    ];
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
    const [{ rangeStart }] = m.listCalendarForExpert.mock.calls[0] as [{ rangeStart: Date }];
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

describe('loadExpertCalendar — Agenda horizon survives a PAST weekStartDayKey (N5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.findTimezone.mockResolvedValue('Australia/Sydney');
    m.listCalendarForExpert.mockResolvedValue([]);
    mockGetChecklistStatus.mockResolvedValue({ items: { calendar: true } });
  });

  it('clamps rangeEnd to at least today + AGENDA_HORIZON when the visible week is far in the past, so a call happening TODAY is not excluded from the fetch range', async () => {
    const { loadExpertCalendar } = await import('./load-expert-calendar');

    // Paging back to a week in January while "today" (faked) is 2026-08-20 — the exact shape of
    // the failure scenario: `weekStart + 28d` (2026-02-02) is months before "today". Without the
    // clamp, `rangeEnd` would land there and every current meeting would be excluded from the
    // repository query — Agenda would render "You're all clear" to an expert with a call in two
    // hours (the exact bug N5 reports).
    await loadExpertCalendar({
      expertProfileId: EXPERT_PROFILE_ID,
      userId: USER_ID,
      weekStartDayKey: '2026-01-05',
    });

    expect(m.listCalendarForExpert).toHaveBeenCalledTimes(1);
    const calls = m.listCalendarForExpert.mock.calls as [{ rangeStart: Date; rangeEnd: Date }][];
    const [call] = calls;
    if (call === undefined) throw new Error('listCalendarForExpert was not called');
    const [{ rangeStart, rangeEnd }] = call;

    // rangeEnd is clamped forward to `today (2026-08-20) + 28d` = 2026-09-17 local, NOT
    // `weekStart (2026-01-05) + 28d` = 2026-02-02 local.
    expect(rangeEnd.toISOString()).toBe('2026-09-16T14:00:00.000Z');
    // The concrete assertion the failure scenario is about: "now" (the faked system time) falls
    // INSIDE the fetched range, so a call happening today is actually returned by the query.
    expect(rangeStart.getTime()).toBeLessThanOrEqual(FIXED_TODAY.getTime());
    expect(rangeEnd.getTime()).toBeGreaterThan(FIXED_TODAY.getTime());
  });

  it('the WIDEST week the page will accept still produces a range inside the repository’s maximum span (S2)', async () => {
    const { loadExpertCalendar } = await import('./load-expert-calendar');

    // `page.tsx` bounds `?week=` to ±365 days of today and `weekStartDayKey` can round back a
    // further 6, so this is the furthest-past week that can ever reach the loader from a real
    // request: today (2026-08-20) − 371 days. Its `rangeEnd` is then clamped FORWARD to
    // today + 28 (N5), which is what makes this the widest span the pair can produce.
    await loadExpertCalendar({
      expertProfileId: EXPERT_PROFILE_ID,
      userId: USER_ID,
      weekStartDayKey: '2025-08-14',
    });

    const [{ rangeStart, rangeEnd }] = m.listCalendarForExpert.mock.calls[0] as [
      { rangeStart: Date; rangeEnd: Date },
    ];
    const spanDays = (rangeEnd.getTime() - rangeStart.getTime()) / 86_400_000;
    expect(spanDays).toBeLessThanOrEqual(MAX_CALENDAR_RANGE_DAYS);
    // Non-vacuous: this really is a near-maximal window, not a trivially small one.
    expect(spanDays).toBeGreaterThan(390);
  });

  it('does NOT extend rangeEnd when the visible week is already beyond the agenda horizon (forward paging unaffected)', async () => {
    const { loadExpertCalendar } = await import('./load-expert-calendar');

    // weekStart is ~60 days ahead of "today" — weekRangeEnd (weekStart+28) is already well past
    // agendaHorizonEnd (today+28), so the clamp must be a no-op here.
    await loadExpertCalendar({
      expertProfileId: EXPERT_PROFILE_ID,
      userId: USER_ID,
      weekStartDayKey: '2026-10-19',
    });

    const [{ rangeEnd }] = m.listCalendarForExpert.mock.calls[0] as [{ rangeEnd: Date }];
    // weekStart(2026-10-19) + 28d = 2026-11-16 local. Daylight saving starts 2026-10-04 in
    // Sydney, so this local midnight is AEDT (+11).
    expect(rangeEnd.toISOString()).toBe('2026-11-15T13:00:00.000Z');
  });
});
