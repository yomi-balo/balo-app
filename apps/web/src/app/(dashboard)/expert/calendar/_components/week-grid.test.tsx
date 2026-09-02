/**
 * BAL-498 — TZ=UTC required (memory `reference_web_tests_need_tz_utc`). Run with:
 *   TZ=UTC pnpm exec vitest run --project web "src/app/(dashboard)/expert/calendar"
 */
import { describe, it, expect, vi } from 'vitest';
import { axe } from 'jest-axe';
import { render, screen, within, fireEvent } from '@/test/utils';
import { MEETING_OVERRUN_GRACE_MINUTES } from '@balo/shared/engagements';
import { WeekGrid } from './week-grid';
import type { CalendarMeetingView } from '../_lib/calendar-view-types';

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});

function meeting(overrides: Partial<CalendarMeetingView>): CalendarMeetingView {
  return {
    meetingId: 'meeting-1',
    scheduledStart: '2026-08-25T00:00:00.000Z',
    scheduledEnd: '2026-08-25T00:30:00.000Z',
    status: 'scheduled',
    contextType: 'case',
    href: '/cases/e1',
    joinUrl: 'https://balo.expert/join/m/meeting-1',
    counterpartyCompanyName: 'Northwind',
    ...overrides,
  };
}

const NOOP = (): void => {};

describe('WeekGrid — AC: at least two engagement types render in correct local time', () => {
  it('renders a case meeting and a project_kickoff meeting on their correct day columns, in Sydney local time', () => {
    // Monday 2026-08-24 is the week start. Tuesday 09:00-09:30 AEST = 2026-08-24T23:00:00Z.
    const caseMeeting = meeting({
      meetingId: 'case-1',
      scheduledStart: '2026-08-24T23:00:00.000Z',
      scheduledEnd: '2026-08-24T23:30:00.000Z',
      contextType: 'case',
      href: '/cases/e1',
      counterpartyCompanyName: 'Northwind',
    });
    // Wednesday 14:00-15:00 AEST = 2026-08-26T04:00:00Z.
    const projectMeeting = meeting({
      meetingId: 'project-1',
      scheduledStart: '2026-08-26T04:00:00.000Z',
      scheduledEnd: '2026-08-26T05:00:00.000Z',
      contextType: 'project_kickoff',
      href: '/engagements/e2',
      counterpartyCompanyName: 'Globex',
    });

    render(
      <WeekGrid
        weekStartDayKey="2026-08-24"
        timezone="Australia/Sydney"
        meetings={[caseMeeting, projectMeeting]}
        now={new Date('2026-08-24T00:00:00.000Z')}
        onJoinClick={NOOP}
        isMobile={false}
      />
    );

    // ⚠ ASSERT THE COLUMN, NOT ONLY THE LABEL. A prior version of this test passed even when
    // every meeting was dumped into a single column — only the aria-label time string was
    // checked. `data-day-key` (week-grid.tsx) is what makes the column itself queryable.
    const tuesdayColumn = document.querySelector('[data-day-key="2026-08-25"]');
    const wednesdayColumn = document.querySelector('[data-day-key="2026-08-26"]');
    expect(tuesdayColumn).not.toBeNull();
    expect(wednesdayColumn).not.toBeNull();
    expect(
      within(tuesdayColumn as HTMLElement).getByLabelText(/9:00 – 9:30 AM, Case with Northwind/i)
    ).toBeInTheDocument();
    expect(
      within(wednesdayColumn as HTMLElement).getByLabelText(/2:00 – 3:00 PM, Project with Globex/i)
    ).toBeInTheDocument();
  });

  it('a retainer_checkin (unmapped colour) falls back to the neutral treatment and does not crash', () => {
    const fallback = meeting({
      meetingId: 'retainer-1',
      contextType: 'retainer_checkin',
      href: null,
      counterpartyCompanyName: null,
    });
    render(
      <WeekGrid
        weekStartDayKey="2026-08-24"
        timezone="Australia/Sydney"
        meetings={[fallback]}
        now={new Date('2026-08-24T00:00:00.000Z')}
        onJoinClick={NOOP}
        isMobile={false}
      />
    );
    expect(screen.getByLabelText(/Meeting with Balo/i)).toBeInTheDocument();
  });
});

describe('WeekGrid — accessibility structure (A2)', () => {
  // A2 + fix round 6 item 4. The invariant is unchanged — the grid must carry the SAME accessible
  // name — only the element supplying the role changed, from `<div role="group">` to a named
  // `<section>`, whose implicit role is `region` (SonarCloud S6819: use the real element). A
  // regression to a bare unlabelled `<div>` still fails here: it exposes no role at all.
  it('the grid itself is a NAMED region, not a bare unlabelled div', () => {
    render(
      <WeekGrid
        weekStartDayKey="2026-08-24"
        rangeLabel="24 Aug – 30 Aug, 2026"
        timezone="Australia/Sydney"
        meetings={[]}
        now={new Date('2026-08-24T00:00:00.000Z')}
        onJoinClick={NOOP}
        isMobile={false}
      />
    );

    expect(
      screen.getByRole('region', { name: 'Week of 24 Aug – 30 Aug, 2026' })
    ).toBeInTheDocument();
  });

  /**
   * The `id="calendar-availability-summary-${dayKey}"` values `AvailabilityShading` emits were
   * referenced by NOTHING — the component's own comment called them "for a future
   * `aria-describedby` wire". A screen-reader user therefore got all seven summaries dumped as
   * one disconnected block instead of each attached to its day, and the shading wash (which has
   * no other text or icon equivalent) failed "colour is not the only way to convey information".
   */
  it('each day column header points aria-describedby at that day’s availability summary id, and every one of the seven RESOLVES', () => {
    // ⚠ The overlay emits ALL SEVEN ids — the real `AvailabilityShading` does, in its `ready`
    // state. A prior version of this test emitted ONE and still asserted seven refs, which
    // actively BLESSED six dangling references as correct (BAL-498 fix round 4, item 2).
    render(
      <WeekGrid
        weekStartDayKey="2026-08-24"
        timezone="Australia/Sydney"
        meetings={[]}
        now={new Date('2026-08-24T00:00:00.000Z')}
        onJoinClick={NOOP}
        isMobile={false}
        shadingDescribesDays
        renderShadingOverlay={(_gridRange, visibleDayKeys) => (
          <span>
            {visibleDayKeys.map((dayKey) => (
              <span key={dayKey} id={`calendar-availability-summary-${dayKey}`}>
                No availability set
              </span>
            ))}
          </span>
        )}
      />
    );

    const described = [...document.querySelectorAll('[aria-describedby]')].map((node) =>
      node.getAttribute('aria-describedby')
    );
    expect(described).toContain('calendar-availability-summary-2026-08-24');
    expect(described).toContain('calendar-availability-summary-2026-08-30');
    expect(described).toHaveLength(7);
    // NOT ONE of them may dangle. axe reports a dangling IDREF as `aria-valid-attr-value`
    // *incomplete*, which `toHaveNoViolations` does not fail on — so this has to be explicit.
    for (const id of described) {
      expect(id).not.toBeNull();
      expect(document.getElementById(id as string)).not.toBeNull();
    }
  });

  it('with no shading overlay mounted there is no DANGLING aria-describedby to a nonexistent id', () => {
    render(
      <WeekGrid
        weekStartDayKey="2026-08-24"
        timezone="Australia/Sydney"
        meetings={[]}
        now={new Date('2026-08-24T00:00:00.000Z')}
        onJoinClick={NOOP}
        isMobile={false}
      />
    );

    expect(document.querySelectorAll('[aria-describedby]')).toHaveLength(0);
  });

  it('an overlay that is MOUNTED but renders nothing (every non-ready state) emits no aria-describedby either', () => {
    // BAL-498 fix round 4, item 2. The gate used to be `renderShadingOverlay === undefined`, but being
    // SUPPLIED is not the same as RENDERING the ids: `availability-shading.tsx` returns `null` for
    // `loading` — the FIRST RENDER OF EVERY WEEK VIEW — and for `error`, `unavailable`,
    // `not_published`, `not_configured` and `empty_window`. That emitted seven dangling IDREFs on
    // every one of those states.
    render(
      <WeekGrid
        weekStartDayKey="2026-08-24"
        timezone="Australia/Sydney"
        meetings={[]}
        now={new Date('2026-08-24T00:00:00.000Z')}
        onJoinClick={NOOP}
        isMobile={false}
        shadingDescribesDays={false}
        renderShadingOverlay={() => null}
      />
    );

    expect(document.querySelectorAll('[aria-describedby]')).toHaveLength(0);
  });
});

describe('WeekGrid — the grid range covers the availability shading it is asked to paint (R3 / round 4)', () => {
  it('a cross-midnight shading window, supplied as the same TWO fragments the wash paints, widens the range over minute 0 AND minute 1440', () => {
    // A 22:00→02:00 availability rule. `CalendarShell` must hand this down already fragmented at
    // local midnight (`zonedMeetingSpan`), exactly as it does for meetings.
    let received: { start: number; end: number } | null = null;
    render(
      <WeekGrid
        weekStartDayKey="2026-08-24"
        timezone="Australia/Sydney"
        meetings={[]}
        now={new Date('2026-08-24T00:00:00.000Z')}
        onJoinClick={NOOP}
        isMobile={false}
        shadingMinuteSpans={[
          { startMinutes: 1320, endMinutes: 1440 },
          { startMinutes: 0, endMinutes: 120 },
        ]}
        renderShadingOverlay={(gridRange) => {
          received = gridRange;
          return null;
        }}
      />
    );

    // Both ends are covered, so neither fragment can paint above `top: 0` (a container that
    // cannot scroll negative) or below the bottom of the grid body.
    expect(received).toEqual({ start: 0, end: 1440 });
  });

  it('an INVERTED single span cannot be rescued here — which is why the caller must fragment', () => {
    // `{ startMinutes: 1320, endMinutes: 120 }` is what the pre-round-4 `shadingMinuteSpans`
    // derivation produced for that same 22:00→02:00 rule (`zonedMinutesOfDay` on BOTH ends).
    // 1320 is not < 420 and 120 is not > 1140, so the grid widens in NEITHER direction and the
    // default 7 AM–7 PM range stands — while the wash paints two fragments at 1320-1440 and
    // 0-120, i.e. entirely outside it. This case documents the coupling; the fix lives in
    // `calendar-shell.tsx` and is pinned in `calendar-shell.test.tsx`.
    let received: { start: number; end: number } | null = null;
    render(
      <WeekGrid
        weekStartDayKey="2026-08-24"
        timezone="Australia/Sydney"
        meetings={[]}
        now={new Date('2026-08-24T00:00:00.000Z')}
        onJoinClick={NOOP}
        isMobile={false}
        shadingMinuteSpans={[{ startMinutes: 1320, endMinutes: 120 }]}
        renderShadingOverlay={(gridRange) => {
          received = gridRange;
          return null;
        }}
      />
    );

    expect(received).toEqual({ start: 420, end: 1140 });
  });
});

describe('WeekGrid — accessibility (plan §12.2 axe pass)', () => {
  it('has no axe violations with a mix of full, compact and unlinked meetings', async () => {
    const { container } = render(
      <WeekGrid
        weekStartDayKey="2026-08-24"
        timezone="Australia/Sydney"
        meetings={[
          meeting({
            meetingId: 'full-1',
            scheduledStart: '2026-08-24T23:00:00.000Z',
            scheduledEnd: '2026-08-24T23:30:00.000Z',
          }),
          meeting({
            meetingId: 'compact-1',
            scheduledStart: '2026-08-25T23:00:00.000Z',
            scheduledEnd: '2026-08-25T23:10:00.000Z',
          }),
          meeting({ meetingId: 'unlinked-1', href: null, counterpartyCompanyName: null }),
        ]}
        now={new Date('2026-08-24T00:00:00.000Z')}
        onJoinClick={NOOP}
        isMobile={false}
      />
    );

    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('WeekGrid — AC: DST correctness', () => {
  it('a meeting spanning the 2026-10-04 spring-forward gap renders 120 wall-clock minutes tall, not 60', () => {
    // Week containing the transition: Monday 2026-09-28.
    const dstMeeting = meeting({
      meetingId: 'dst-1',
      // 2026-10-04 01:30 AEST = 2026-10-03T15:30:00Z; 03:30 AEDT = 2026-10-03T16:30:00Z.
      scheduledStart: '2026-10-03T15:30:00.000Z',
      scheduledEnd: '2026-10-03T16:30:00.000Z',
      contextType: 'case',
      href: '/cases/dst',
      counterpartyCompanyName: 'Transition Co',
    });

    render(
      <WeekGrid
        weekStartDayKey="2026-09-28"
        timezone="Australia/Sydney"
        meetings={[dstMeeting]}
        now={new Date('2026-09-28T00:00:00.000Z')}
        onJoinClick={NOOP}
        isMobile={false}
      />
    );

    const link = screen.getByLabelText(/1:30 – 3:30 AM, Case with Transition Co/i);
    const positioned = link.parentElement;
    expect(positioned).not.toBeNull();
    // 120 wall-clock minutes at 64px/hour = 128px. The regression this test exists to catch:
    // the elapsed REAL duration is only 60 minutes (the 02:00-02:59 hour never occurred).
    const heightPx = Number(positioned?.style.height.replace('px', ''));
    expect(heightPx).toBeCloseTo((120 / 60) * 64, 0);
  });
});

describe('WeekGrid — AC: a meeting crossing local midnight renders TWO fragments (H9)', () => {
  it('a 23:45-00:15 AEST meeting renders once at the bottom of its start day AND once at the top of the next day, both linking to the same target', () => {
    // 2026-08-24 23:45 AEST = 2026-08-24T13:45:00Z; ends 2026-08-25 00:15 AEST = 2026-08-24T14:15:00Z.
    const crossMidnight = meeting({
      meetingId: 'cross-1',
      scheduledStart: '2026-08-24T13:45:00.000Z',
      scheduledEnd: '2026-08-24T14:15:00.000Z',
      href: '/cases/cross-1',
      counterpartyCompanyName: 'Overnight Co',
    });

    render(
      <WeekGrid
        weekStartDayKey="2026-08-24"
        timezone="Australia/Sydney"
        meetings={[crossMidnight]}
        now={new Date('2026-08-24T00:00:00.000Z')}
        onJoinClick={NOOP}
        isMobile={false}
      />
    );

    const mondayColumn = document.querySelector('[data-day-key="2026-08-24"]') as HTMLElement;
    const tuesdayColumn = document.querySelector('[data-day-key="2026-08-25"]') as HTMLElement;

    // Both fragments exist, both accessible, NEITHER day is silently empty. `getByRole('link', …)`
    // (not `getByLabelText`) because each 15-minute-tall fragment ALSO renders a compact-mode
    // Popover-trigger button whose OWN aria-label happens to match /Overnight Co/ too.
    const mondayFragment = within(mondayColumn).getByRole('link', { name: /Overnight Co/i });
    const tuesdayFragment = within(tuesdayColumn).getByRole('link', { name: /Overnight Co/i });
    expect(mondayFragment).toBeInTheDocument();
    expect(tuesdayFragment).toBeInTheDocument();
    // Same target — a client scanning either day can reach the meeting.
    expect(mondayFragment.getAttribute('href')).toBe('/cases/cross-1');
    expect(tuesdayFragment.getAttribute('href')).toBe('/cases/cross-1');
  });
});

/**
 * BAL-511 D1 — `WeekGrid` now computes `isPast`/`joinVisible`/`joinTimingLabel` via
 * `calendarMeetingTiming` and hands PRIMITIVES down to the memoised `MeetingBlock`. The
 * behavioural coverage `meeting-block.test.tsx` lost ("Join appears when imminent") lands here,
 * where the derivation now actually lives.
 */
/**
 * BAL-513 C2 — the overrun grace and terminal-status tests below (AC4) exercise the SAME
 * `calendarMeetingTiming` composition `agenda-list.test.tsx`'s "the overrun grace and
 * terminal-status gate" describe block exercises via `AgendaList`'s converged path (D6). Week and
 * Agenda must never disagree about the same meeting.
 */
describe('WeekGrid — the now-derived MeetingBlock inputs are computed HERE (BAL-511)', () => {
  const WG_NOW = new Date('2026-08-25T09:00:00.000Z');

  it('offers Join only for the meeting inside the window, and names its timing', () => {
    render(
      <WeekGrid
        weekStartDayKey="2026-08-24"
        timezone="UTC"
        meetings={[
          meeting({
            meetingId: 'soon',
            scheduledStart: '2026-08-25T09:05:00.000Z',
            scheduledEnd: '2026-08-25T09:35:00.000Z',
            counterpartyCompanyName: 'Soon Co',
          }),
          meeting({
            meetingId: 'later',
            scheduledStart: '2026-08-25T10:00:00.000Z',
            scheduledEnd: '2026-08-25T10:30:00.000Z',
            counterpartyCompanyName: 'Later Co',
          }),
        ]}
        now={WG_NOW}
        onJoinClick={NOOP}
        isMobile={false}
      />
    );

    expect(
      screen.getByRole('button', { name: "Join Soon Co's meeting, starting in 5 minutes" })
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Join Later Co/i })).not.toBeInTheDocument();
  });

  it('mutes a meeting that has already ended', () => {
    const { container } = render(
      <WeekGrid
        weekStartDayKey="2026-08-24"
        timezone="UTC"
        meetings={[
          meeting({
            meetingId: 'ended',
            scheduledStart: '2026-08-25T07:00:00.000Z',
            scheduledEnd: '2026-08-25T07:30:00.000Z',
          }),
        ]}
        now={WG_NOW}
        onJoinClick={NOOP}
        isMobile={false}
      />
    );

    // 90 minutes past the end at WG_NOW (09:00) — well past the 30-minute grace, so this still
    // passes; the margin is now grace-dependent (BAL-513).
    expect(container.innerHTML).toContain('opacity-60');
  });

  it('offers Join at scheduledEnd + grace − 1 minute (AC4)', () => {
    const scheduledEnd = new Date(
      WG_NOW.getTime() - (MEETING_OVERRUN_GRACE_MINUTES - 1) * 60_000
    ).toISOString();
    const scheduledStart = new Date(new Date(scheduledEnd).getTime() - 30 * 60_000).toISOString();
    render(
      <WeekGrid
        weekStartDayKey="2026-08-24"
        timezone="UTC"
        meetings={[
          meeting({
            meetingId: 'overrun-inside-grace',
            scheduledStart,
            scheduledEnd,
            status: 'in_progress',
            counterpartyCompanyName: 'Grace Co',
          }),
        ]}
        now={WG_NOW}
        onJoinClick={NOOP}
        isMobile={false}
      />
    );

    expect(screen.getByRole('button', { name: /Join Grace Co/i })).toBeInTheDocument();
  });

  it('hides Join at scheduledEnd + grace (AC4)', () => {
    const scheduledEnd = new Date(
      WG_NOW.getTime() - MEETING_OVERRUN_GRACE_MINUTES * 60_000
    ).toISOString();
    const scheduledStart = new Date(new Date(scheduledEnd).getTime() - 30 * 60_000).toISOString();
    render(
      <WeekGrid
        weekStartDayKey="2026-08-24"
        timezone="UTC"
        meetings={[
          meeting({
            meetingId: 'overrun-past-grace',
            scheduledStart,
            scheduledEnd,
            status: 'in_progress',
            counterpartyCompanyName: 'Elapsed Co',
          }),
        ]}
        now={WG_NOW}
        onJoinClick={NOOP}
        isMobile={false}
      />
    );

    expect(screen.queryByRole('button', { name: /Join Elapsed Co/i })).not.toBeInTheDocument();
  });

  it('hides Join for a meeting whose status is terminal at load, even mid-slot (AC4)', () => {
    render(
      <WeekGrid
        weekStartDayKey="2026-08-24"
        timezone="UTC"
        meetings={[
          meeting({
            meetingId: 'terminal-mid-slot',
            scheduledStart: '2026-08-25T08:30:00.000Z',
            scheduledEnd: '2026-08-25T09:30:00.000Z',
            status: 'ended',
            counterpartyCompanyName: 'Terminal Co',
          }),
        ]}
        now={WG_NOW}
        onJoinClick={NOOP}
        isMobile={false}
      />
    );

    expect(screen.queryByRole('button', { name: /Join Terminal Co/i })).not.toBeInTheDocument();
  });

  it('does NOT mute an overrunning meeting while its Join is still live (D6)', () => {
    const scheduledEnd = new Date(WG_NOW.getTime() - 10 * 60_000).toISOString();
    const scheduledStart = new Date(new Date(scheduledEnd).getTime() - 30 * 60_000).toISOString();
    const { container } = render(
      <WeekGrid
        weekStartDayKey="2026-08-24"
        timezone="UTC"
        meetings={[
          meeting({
            meetingId: 'overrun-live',
            scheduledStart,
            scheduledEnd,
            status: 'in_progress',
          }),
        ]}
        now={WG_NOW}
        onJoinClick={NOOP}
        isMobile={false}
      />
    );

    expect(container.innerHTML).not.toContain('opacity-60');
  });

  it('mutes a terminal meeting immediately, even mid-slot', () => {
    const { container } = render(
      <WeekGrid
        weekStartDayKey="2026-08-24"
        timezone="UTC"
        meetings={[
          meeting({
            meetingId: 'terminal-immediate',
            scheduledStart: '2026-08-25T08:30:00.000Z',
            scheduledEnd: '2026-08-25T09:30:00.000Z',
            status: 'ended',
          }),
        ]}
        now={WG_NOW}
        onJoinClick={NOOP}
        isMobile={false}
      />
    );

    expect(container.innerHTML).toContain('opacity-60');
  });
});

describe('WeekGrid — mobile renders a genuine single-day grid, not a shrunken 7-column one (H6)', () => {
  it('mobile shows exactly ONE day column, defaulting to today', () => {
    const monday = meeting({
      meetingId: 'mon-1',
      scheduledStart: '2026-08-23T23:00:00.000Z',
      scheduledEnd: '2026-08-23T23:30:00.000Z',
      href: '/cases/mon-1',
      counterpartyCompanyName: 'Monday Co',
    });
    const tuesday = meeting({
      meetingId: 'tue-1',
      scheduledStart: '2026-08-24T23:00:00.000Z',
      scheduledEnd: '2026-08-24T23:30:00.000Z',
      href: '/cases/tue-1',
      counterpartyCompanyName: 'Tuesday Co',
    });

    render(
      <WeekGrid
        weekStartDayKey="2026-08-24"
        timezone="Australia/Sydney"
        meetings={[monday, tuesday]}
        // "now" = Tuesday 2026-08-25 09:00 AEST local -> defaults the mobile day to Tuesday.
        now={new Date('2026-08-24T23:05:00.000Z')}
        onJoinClick={NOOP}
        isMobile
      />
    );

    const dayColumns = document.querySelectorAll('[data-day-key]');
    expect(dayColumns).toHaveLength(1);
    expect(screen.getByText('Tuesday Co')).toBeInTheDocument();
    expect(screen.queryByText('Monday Co')).not.toBeInTheDocument();
    // Day-named prev/next chevrons are present (Mobile Adaptations).
    expect(screen.getByRole('button', { name: 'Previous day' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next day' })).toBeInTheDocument();
  });

  it('A4 — the day-nav chevrons, the PRIMARY mobile navigation control, clear the 44px minimum', () => {
    render(
      <WeekGrid
        weekStartDayKey="2026-08-24"
        timezone="Australia/Sydney"
        meetings={[]}
        now={new Date('2026-08-24T23:05:00.000Z')}
        onJoinClick={NOOP}
        isMobile
      />
    );

    // Was `size="icon-sm"` (32px). `size="icon"` (36px) + 6px of transparent pseudo-element on
    // every side = 48px, with no change to the visual chevron.
    for (const label of ['Previous day', 'Next day']) {
      const button = screen.getByRole('button', { name: label });
      expect(button.className).toContain('size-9');
      expect(button.className).toContain('after:-inset-1.5');
      expect(button.className).not.toContain('size-8');
    }
  });

  it('tapping the previous-day chevron steps back one day within the week', () => {
    const monday = meeting({
      meetingId: 'mon-1',
      scheduledStart: '2026-08-23T23:00:00.000Z',
      scheduledEnd: '2026-08-23T23:30:00.000Z',
      href: '/cases/mon-1',
      counterpartyCompanyName: 'Monday Co',
    });

    render(
      <WeekGrid
        weekStartDayKey="2026-08-24"
        timezone="Australia/Sydney"
        meetings={[monday]}
        now={new Date('2026-08-24T23:05:00.000Z')}
        onJoinClick={NOOP}
        isMobile
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Previous day' }));

    expect(screen.getByText('Monday Co')).toBeInTheDocument();
  });

  it('renderShadingOverlay receives the ONE visible mobile day key, not the full seven-day week (N2)', () => {
    // BAL-498 fix round 2, N2: the overlay used to always get the seven-key `dayKeys` array and
    // lay rects out assuming seven columns, painting seven slivers of a DIFFERENT day's hours
    // over the single visible mobile column. `renderShadingOverlay` must receive the SAME
    // `visibleDayKeys` the grid itself renders columns for.
    const monday = meeting({
      meetingId: 'mon-1',
      scheduledStart: '2026-08-23T23:00:00.000Z',
      scheduledEnd: '2026-08-23T23:30:00.000Z',
    });

    let receivedDayKeys: readonly string[] = [];
    render(
      <WeekGrid
        weekStartDayKey="2026-08-24"
        timezone="Australia/Sydney"
        meetings={[monday]}
        // "now" = Tuesday 2026-08-25 09:00 AEST local -> defaults the mobile day to Tuesday.
        now={new Date('2026-08-24T23:05:00.000Z')}
        onJoinClick={NOOP}
        isMobile
        renderShadingOverlay={(_gridRange, visibleDayKeys) => {
          receivedDayKeys = visibleDayKeys;
          return <div data-testid="shading-probe" />;
        }}
      />
    );

    expect(screen.getByTestId('shading-probe')).toBeInTheDocument();
    expect(receivedDayKeys).toEqual(['2026-08-25']);
  });
});
