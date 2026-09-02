import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, fireEvent, act } from '@/test/utils';
import { CalendarShell } from './calendar-shell';
import type { CalendarPageView, CalendarMeetingView } from '../_lib/calendar-view-types';
import { addDaysToDayKey, todayDayKey } from '@/lib/calendar/zoned-grid';
import { CALENDAR_EVENTS } from '@/lib/analytics';
import type { AvailabilityView } from '@/components/availability/use-expert-availability';

/**
 * BAL-498 fix round 1 — B6. `calendar-shell.tsx` shipped with ZERO tests (0% coverage, 279
 * lines) despite owning view state, week navigation, the 60-second Join tick, and every
 * empty-state/note branching rule. This file covers plan §12.2's four named scenarios (initial
 * vs switch `calendar_viewed`, `?view=` honoured, week nav + `aria-disabled` Today, fake-timer
 * Join appear/disappear) plus the H2/H3/H4/H5 fix-round behaviours.
 */

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});

/**
 * BAL-511 — the "Edit availability" header action is `<Button asChild><Link>`. The real
 * app-router `Link` needs an `AppRouterContext` that `@/test/utils` does not provide, and
 * clicking it is required by the analytics test case below — copied verbatim from
 * `calendar-empty-states.test.tsx:9-21` (same directory family, same `Button asChild` + `Link` +
 * `onClick` track shape). Existing assertions elsewhere in this file that query links by href
 * still pass against the plain `<a>` this mock renders.
 */
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} data-next-link="true" {...rest}>
      {children}
    </a>
  ),
}));

let mockSearchParams = new URLSearchParams();
const mockPush = vi.fn();
const mockReplace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  useSearchParams: () => mockSearchParams,
}));

let isMobile = false;
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => isMobile }));

let mockAvailabilityView: AvailabilityView = { kind: 'loading' };
const mockUseExpertAvailability = vi.fn();
// ⚠ ONE STABLE `reload` identity across renders — the real hook memoises it with no deps, and
// the shell lifts it through an effect. A `vi.fn()` created inline per render would both hide a
// re-fire bug and make "the retry button calls reload" unassertable (R4).
const mockReload = vi.fn();
vi.mock('@/components/availability/use-expert-availability', () => ({
  useExpertAvailability: (...args: unknown[]) => {
    mockUseExpertAvailability(...args);
    return { view: mockAvailabilityView, reload: mockReload };
  },
}));

const mockTrack = vi.fn();
vi.mock('@/lib/analytics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/analytics')>();
  return { ...actual, track: (...args: unknown[]) => mockTrack(...args) };
});

function meeting(overrides: Partial<CalendarMeetingView> = {}): CalendarMeetingView {
  return {
    meetingId: 'm-1',
    scheduledStart: '2026-08-24T23:00:00.000Z',
    scheduledEnd: '2026-08-24T23:30:00.000Z',
    status: 'scheduled',
    contextType: 'case',
    href: '/cases/e1',
    joinUrl: 'https://balo.expert/join/m/m-1',
    counterpartyCompanyName: 'Northwind',
    ...overrides,
  };
}

function pageView(overrides: Partial<CalendarPageView> = {}): CalendarPageView {
  return {
    expertProfileId: 'expert-1',
    timezone: 'Australia/Sydney',
    meetings: [],
    hasConnectedCalendar: true,
    ...overrides,
  };
}

/** Every state in which `AvailabilityShading` renders `null` — i.e. emits NO summary ids.
 *  `loading` is the first render of every Week view, so it is the common case, not an edge one. */
const NON_READY_VIEWS: [string, AvailabilityView][] = [
  ['loading', { kind: 'loading' }],
  ['error', { kind: 'error' }],
  ['unavailable', { kind: 'unavailable' }],
  ['not_published', { kind: 'not_published' }],
  ['not_configured', { kind: 'not_configured' }],
  ['empty_window', { kind: 'empty_window', days: 7 }],
];

const FIXED_NOW = new Date('2026-08-24T00:00:00.000Z'); // Monday 10:00 AEST

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  mockSearchParams = new URLSearchParams();
  isMobile = false;
  mockAvailabilityView = { kind: 'loading' };
  mockPush.mockClear();
  mockReplace.mockClear();
  mockTrack.mockClear();
  mockUseExpertAvailability.mockClear();
  mockReload.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CalendarShell — calendar_viewed analytics (plan §12.2)', () => {
  it('fires calendar_viewed with source "initial" on mount (desktop default: week)', () => {
    render(<CalendarShell view={pageView()} initialWeekStartDayKey="2026-08-24" />);

    // BAL-498 fix round 2, suggestion — `expect.objectContaining({ toString: expect.anything() })`
    // matched ANY object, leaving the event NAME itself unpinned (a typo in the constant would
    // have sailed through). Assert the real constant instead.
    expect(mockTrack).toHaveBeenCalledWith(CALENDAR_EVENTS.VIEWED, {
      view: 'week',
      source: 'initial',
      week_offset: 0,
    });
  });

  it('switching view fires calendar_viewed with source "switch" and writes ?view=', () => {
    render(<CalendarShell view={pageView()} initialWeekStartDayKey="2026-08-24" />);
    mockTrack.mockClear();

    // A3 — the switcher is a RADIOGROUP, not an incomplete tablist (there was never a tabpanel
    // for `role="tab"` to control). See `calendar-view-switcher.test.tsx`.
    const agendaOption = screen.getByRole('radio', { name: /agenda/i });
    fireEvent.click(agendaOption);

    expect(mockTrack).toHaveBeenCalledWith(CALENDAR_EVENTS.VIEWED, {
      view: 'agenda',
      source: 'switch',
      week_offset: 0,
    });
    // ⚠ `replace`, not `push` — see the F4 block at the bottom of this file for why. This
    // assertion was `mockPush` until BAL-498 fix round 5.
    expect(mockReplace).toHaveBeenCalledWith(
      expect.stringContaining('view=agenda'),
      expect.objectContaining({ scroll: false })
    );
  });
});

describe('CalendarShell — ?view= is honoured on initial mount', () => {
  it('renders Agenda when ?view=agenda is present, even though isMobile is false (desktop default is week)', () => {
    mockSearchParams = new URLSearchParams('view=agenda');
    render(
      <CalendarShell
        view={pageView({ meetings: [meeting()] })}
        initialWeekStartDayKey="2026-08-24"
      />
    );

    expect(screen.getByRole('radio', { name: /agenda/i })).toHaveAttribute('aria-checked', 'true');
  });
});

describe('CalendarShell — week navigation (plan §12.2)', () => {
  it('"Today" is aria-disabled when the visible week contains today, and navigation uses router.push (M2, back-button-correct)', () => {
    render(<CalendarShell view={pageView()} initialWeekStartDayKey="2026-08-24" />);

    const todayButton = screen.getByRole('button', { name: 'Today' });
    expect(todayButton).toHaveAttribute('aria-disabled', 'true');

    const nextButton = screen.getByRole('button', { name: 'Next week' });
    fireEvent.click(nextButton);

    expect(mockPush).toHaveBeenCalledWith(
      expect.stringContaining('week=2026-08-31'),
      expect.objectContaining({ scroll: false })
    );
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('"Today" is enabled (not aria-disabled) when the visible week does NOT contain today', () => {
    render(<CalendarShell view={pageView()} initialWeekStartDayKey="2026-09-21" />);

    expect(screen.getByRole('button', { name: 'Today' })).toHaveAttribute('aria-disabled', 'false');
  });
});

describe('CalendarShell — Join appears/disappears with the 60-second tick (fake-timer)', () => {
  it('a meeting 20 minutes out has no Join button; once inside the 15-minute window (after two ticks) Join appears', () => {
    const upcoming = meeting({
      meetingId: 'soon-1',
      scheduledStart: new Date(FIXED_NOW.getTime() + 20 * 60_000).toISOString(),
      scheduledEnd: new Date(FIXED_NOW.getTime() + 50 * 60_000).toISOString(),
    });
    render(
      <CalendarShell
        view={pageView({ meetings: [upcoming] })}
        initialWeekStartDayKey="2026-08-24"
      />
    );

    // S1 — the Join affordance is a `<button>` that NAVIGATES; it is deliberately never a link
    // (an `href` here shipped the sensitive lobby URL to PostHog autocapture and Sentry Replay).
    expect(screen.queryByRole('button', { name: /Join/i })).not.toBeInTheDocument();

    // Advance past the 15-minute join-window boundary (20 - 15 = 5 minutes -> tick past minute 6).
    vi.setSystemTime(new Date(FIXED_NOW.getTime() + 6 * 60_000));
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(screen.getByRole('button', { name: /Join/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Join/i })).not.toBeInTheDocument();
  });
});

describe('CalendarShell — empty states (H2: banner vs full-page)', () => {
  it('no calendar connected AND no meetings -> full-page empty state', () => {
    render(
      <CalendarShell
        view={pageView({ hasConnectedCalendar: false, meetings: [] })}
        initialWeekStartDayKey="2026-08-24"
      />
    );

    expect(screen.getByText(/Connect a calendar to see your week/i)).toBeInTheDocument();
  });

  it('no calendar connected but REAL meetings exist -> inline banner, grid still renders the meeting (H2)', () => {
    render(
      <CalendarShell
        view={pageView({ hasConnectedCalendar: false, meetings: [meeting()] })}
        initialWeekStartDayKey="2026-08-24"
      />
    );

    expect(screen.queryByText(/Connect a calendar to see your week/i)).not.toBeInTheDocument();
    // A5 — NEUTRAL copy. `hasConnectedCalendar` is one boolean and cannot distinguish "never
    // connected" from "credential revoked", so the banner must assert neither.
    expect(
      screen.getByText(/Balo isn't connected to your calendar right now/i)
    ).toBeInTheDocument();
    expect(screen.getByText('Northwind')).toBeInTheDocument();
  });

  it('the not-connected banner never tells an expert to RECONNECT something they may never have connected (A5)', () => {
    render(
      <CalendarShell
        view={pageView({ hasConnectedCalendar: false, meetings: [meeting()] })}
        initialWeekStartDayKey="2026-08-24"
      />
    );

    expect(screen.queryByText(/Reconnect your calendar/i)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Set up your calendar connection/i })).toHaveAttribute(
      'href',
      '/expert/settings?tab=schedule&setup=calendar'
    );
  });

  it('the not-connected banner is legible in DARK MODE: text-warning over the tint, never text-warning-foreground (C2)', () => {
    // In `globals.css`'s `.dark` block `--warning-foreground` is byte-identical to
    // `--background`, so `text-warning-foreground` over `bg-warning/10` paints
    // background-coloured text — invisible. Only SOLID `bg-warning` may pair with `-foreground`.
    render(
      <CalendarShell
        view={pageView({ hasConnectedCalendar: false, meetings: [meeting()] })}
        initialWeekStartDayKey="2026-08-24"
      />
    );

    const banner = screen.getByText(/Balo isn't connected to your calendar right now/i);
    expect(banner.className).toContain('bg-warning/10');
    expect(banner.className).toContain('text-warning');
    expect(banner.className).not.toContain('text-warning-foreground');
    expect(banner.className).toContain('border-warning/30');
  });
});

describe('CalendarShell — the shading sub-surface has all FOUR async states (R4)', () => {
  it('LOADING renders a muted note instead of nothing — the grid no longer paints unshaded with no explanation', () => {
    mockAvailabilityView = { kind: 'loading' };
    render(<CalendarShell view={pageView()} initialWeekStartDayKey="2026-08-24" />);

    expect(screen.getByText(/Loading your available hours/i)).toBeInTheDocument();
  });

  it('ERROR offers a real retry, and it calls the hook’s reload (balo-ui: "Always include a retry action")', () => {
    mockAvailabilityView = { kind: 'error' };
    render(<CalendarShell view={pageView()} initialWeekStartDayKey="2026-08-24" />);

    const retry = screen.getByRole('button', { name: 'Try again' });
    expect(retry).toBeInTheDocument();
    expect(mockReload).not.toHaveBeenCalled();

    fireEvent.click(retry);

    // The regression: `availability-shading.tsx` destructured only `{ view }`, DISCARDING the
    // `reload` the hook exposes, so the error state was terminal until a full page reload.
    expect(mockReload).toHaveBeenCalledTimes(1);
  });

  it('UNAVAILABLE (503, retryable by definition) offers the same retry', () => {
    mockAvailabilityView = { kind: 'unavailable' };
    render(<CalendarShell view={pageView()} initialWeekStartDayKey="2026-08-24" />);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(mockReload).toHaveBeenCalledTimes(1);
  });

  it('no retry button is offered in a state that is not retryable (ready)', () => {
    mockAvailabilityView = {
      kind: 'ready',
      expertTimezone: 'Australia/Sydney',
      days: 7,
      slots: [],
    };
    render(<CalendarShell view={pageView()} initialWeekStartDayKey="2026-08-24" />);

    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });
});

describe('CalendarShell — availability note branches', () => {
  it('empty_window renders the "no bookable time" note (H3)', () => {
    mockAvailabilityView = { kind: 'empty_window', days: 7 };
    render(<CalendarShell view={pageView()} initialWeekStartDayKey="2026-08-24" />);

    expect(screen.getByText(/No bookable time in this window right now/i)).toBeInTheDocument();
  });

  it('a week whose START is beyond the 14-day horizon shows the disclosure note and does NOT mount the shading child (N3 — fixes the H5 over-correction that clamped to 14 even with no partial coverage)', () => {
    // +20 days: the week's START (day 20) is itself past MAX_AVAILABILITY_WINDOW_DAYS (14), so
    // there is no partial coverage to salvage — unlike the genuine partial-coverage case (a week
    // that STARTS inside the horizon but ends outside it), which still clamps and mounts.
    const farFutureWeek = addDaysToDayKey(todayDayKey('Australia/Sydney', FIXED_NOW), 20);
    render(<CalendarShell view={pageView()} initialWeekStartDayKey={farFutureWeek} />);

    expect(screen.getByText(/Availability shading covers the next 14 days/i)).toBeInTheDocument();
    expect(mockUseExpertAvailability).not.toHaveBeenCalled();
  });

  it('a week whose START is beyond the horizon shows ONLY the disclosure note, never the "ready" note — mutually exclusive even if a stale ready view is still in state (N3)', () => {
    // The exact contradiction N3 reports: the child unmounts (shadingMounted=false resets
    // `availabilityView` to null), so even a mock hook that WOULD report "ready" never reaches
    // the page — proving the two notes cannot render together by construction, not by luck.
    mockAvailabilityView = {
      kind: 'ready',
      expertTimezone: 'Australia/Sydney',
      days: 14,
      slots: [],
    };
    const farFutureWeek = addDaysToDayKey(todayDayKey('Australia/Sydney', FIXED_NOW), 20);
    render(<CalendarShell view={pageView()} initialWeekStartDayKey={farFutureWeek} />);

    expect(screen.getByText(/Availability shading covers the next 14 days/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/Shaded time is what clients can still book/i)
    ).not.toBeInTheDocument();
    expect(mockUseExpertAvailability).not.toHaveBeenCalled();
  });

  it('a genuinely partial-coverage week (starts inside the horizon, ends outside it) still clamps to 14 and mounts the shading child (H5 kept)', () => {
    // +10 days: the week STARTS inside the 14-day horizon (day 10) but ENDS outside it (day 16)
    // — the case H5 exists to cover. Distinct from the +20 case above, where the START itself is
    // already beyond the horizon.
    const partialWeek = addDaysToDayKey(todayDayKey('Australia/Sydney', FIXED_NOW), 10);
    render(<CalendarShell view={pageView()} initialWeekStartDayKey={partialWeek} />);

    expect(screen.getByText(/Availability shading covers the next 14 days/i)).toBeInTheDocument();
    expect(mockUseExpertAvailability).toHaveBeenCalledWith('expert-1', 14);
  });

  it('a week entirely in the PAST never mounts the shading child, and shows a past-week note instead of an unexplained unshaded grid (N3)', () => {
    const pastWeek = addDaysToDayKey(todayDayKey('Australia/Sydney', FIXED_NOW), -30);
    render(<CalendarShell view={pageView()} initialWeekStartDayKey={pastWeek} />);

    expect(mockUseExpertAvailability).not.toHaveBeenCalled();
    expect(screen.getByText(/This week is in the past/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/Availability shading covers the next 14 days/i)
    ).not.toBeInTheDocument();
  });

  it('switching to Agenda resets the lifted availabilityView so the Week-only note does not linger (H4)', () => {
    mockAvailabilityView = {
      kind: 'ready',
      expertTimezone: 'Australia/Sydney',
      days: 7,
      slots: [],
    };
    render(<CalendarShell view={pageView()} initialWeekStartDayKey="2026-08-24" />);
    expect(screen.getByText(/Shaded time is what clients can still book/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: /agenda/i }));

    expect(
      screen.queryByText(/Shaded time is what clients can still book/i)
    ).not.toBeInTheDocument();
  });
});

/**
 * BAL-498 fix round 4, item 1. `shadingMinuteSpans` is the SECOND derivation of a slot's minute
 * span (the first is the wash `AvailabilityShading` paints), and it used to be the pre-R3
 * arithmetic — `zonedMinutesOfDay` on both ends. R3 fixed the paint but not the range, so a
 * 22:00→02:00 rule produced the inverted span `{ startMinutes: 1320, endMinutes: 120 }`, which
 * widens `computeGridRangeMinutes` in NEITHER direction: the two painted fragments then landed at
 * `top: 960` (below the bottom of a 768px grid body) and `top: -448` (clipped above a container
 * that cannot scroll negative). Not visible to `week-grid.test.tsx` or
 * `availability-shading.test.tsx`, both of which pin a `gridRange` the caller never produces.
 */
describe('CalendarShell — a cross-midnight availability window paints INSIDE the grid (round 4, item 1)', () => {
  it('every shading rect sits within the grid body: none above top 0, none past the bottom', () => {
    mockAvailabilityView = {
      kind: 'ready',
      expertTimezone: 'Australia/Sydney',
      days: 7,
      // 2026-08-25 22:00 AEST = 2026-08-25T12:00Z → 2026-08-26 02:00 AEST = 2026-08-25T16:00Z.
      slots: [
        { start: '2026-08-25T12:00:00.000Z', end: '2026-08-25T16:00:00.000Z', maxDuration: 60 },
      ],
    };
    render(<CalendarShell view={pageView()} initialWeekStartDayKey="2026-08-24" />);

    // The grid body's height is the range's own height — every day column carries it.
    const dayColumn = document.querySelector('[data-day-key]');
    expect(dayColumn).not.toBeNull();
    const bodyHeight = Number.parseFloat((dayColumn as HTMLElement).style.height);
    expect(bodyHeight).toBeGreaterThan(0);

    const rects = [...document.querySelectorAll('[class*="bg-primary/8"]')];
    // Two fragments, one on each side of local midnight — the wash's own R3 behaviour.
    expect(rects).toHaveLength(2);
    for (const rect of rects) {
      const top = Number.parseFloat((rect as HTMLElement).style.top);
      const height = Number.parseFloat((rect as HTMLElement).style.height);
      expect(height).toBeGreaterThan(0);
      // Reverting the fix puts these at top -448 and top 960 in a 768px-tall body.
      expect(top).toBeGreaterThanOrEqual(0);
      expect(top + height).toBeLessThanOrEqual(bodyHeight + 1);
    }
  });
});

/**
 * BAL-513 AC3 — the SHELL half of the Sunday-crossing-midnight pin (`week-grid.test.tsx:320-361`
 * pins the render half directly). This test exercises `previousWeekLookbackDayKey` against the
 * TWO-WINDOW merged set the loader now produces (`load-expert-calendar.ts`'s
 * `mergeCalendarWindows`), end to end through `CalendarShell`.
 */
describe('CalendarShell — a meeting starting the day before the visible Monday (BAL-513 AC3)', () => {
  it('still renders its Monday continuation fragment', () => {
    // Sun 2026-08-23 23:45 Sydney -> Mon 2026-08-24 00:15 Sydney.
    const sundayCrossing = meeting({
      meetingId: 'sunday-crossing',
      scheduledStart: '2026-08-23T13:45:00.000Z',
      scheduledEnd: '2026-08-23T14:15:00.000Z',
      href: '/cases/sunday-crossing',
      counterpartyCompanyName: 'Weekend Co',
    });

    render(
      <CalendarShell
        view={pageView({ meetings: [sundayCrossing] })}
        initialWeekStartDayKey="2026-08-24"
      />
    );

    const mondayColumn = document.querySelector('[data-day-key="2026-08-24"]') as HTMLElement;
    expect(mondayColumn).not.toBeNull();
    expect(within(mondayColumn).getByRole('link', { name: /Weekend Co/i })).toBeInTheDocument();
  });
});

/**
 * BAL-498 fix round 4, item 2. `AvailabilityShading` renders `null` for every state but `ready`,
 * so gating the day headers' `aria-describedby` on the overlay being SUPPLIED emitted seven
 * dangling IDREFs on `loading` — the first render of every Week view — and on `error`,
 * `unavailable`, `not_published`, `not_configured` and `empty_window`.
 */
describe('CalendarShell — aria-describedby only points at summaries that EXIST (round 4, item 2)', () => {
  /** Every `aria-describedby` value on the page, in DOM order. Page-wide on purpose: the whole
   *  point is that a reference must resolve no matter who emitted it. */
  function describedByRefs(): string[] {
    return [...document.querySelectorAll('[aria-describedby]')].flatMap((node) => {
      const value = node.getAttribute('aria-describedby');
      return value === null ? [] : [value];
    });
  }

  it.each(NON_READY_VIEWS)(
    'kind=%s renders no summary ids, so no day header may reference one',
    (_kind, view) => {
      mockAvailabilityView = view;
      render(<CalendarShell view={pageView()} initialWeekStartDayKey="2026-08-24" />);

      const refs = describedByRefs();
      // No summary element exists in these states — `AvailabilityShading` returns `null`.
      expect(document.querySelectorAll('[id^="calendar-availability-summary-"]')).toHaveLength(0);
      // ...so nothing may point at one. Reverting the fix emits SEVEN dangling refs here.
      expect(refs.filter((ref) => ref.startsWith('calendar-availability-summary-'))).toEqual([]);
      // And the refs that DO survive (the TimezoneChip's explanation) all resolve.
      for (const ref of refs) {
        expect(document.getElementById(ref)).not.toBeNull();
      }
    }
  );

  it('kind=ready wires all seven day headers, and every reference on the page RESOLVES', () => {
    mockAvailabilityView = {
      kind: 'ready',
      expertTimezone: 'Australia/Sydney',
      days: 7,
      slots: [],
    };
    render(<CalendarShell view={pageView()} initialWeekStartDayKey="2026-08-24" />);

    const refs = describedByRefs();
    expect(refs.filter((ref) => ref.startsWith('calendar-availability-summary-'))).toHaveLength(7);
    for (const ref of refs) {
      expect(document.getElementById(ref)).not.toBeNull();
    }
  });
});

/**
 * BAL-498 fix round 5, F4. `handleViewChange` used `router.push`, so every Week↔Agenda toggle
 * stacked a history entry and Back walked through view flips instead of leaving the page — a
 * user who toggled four times needed five Backs to escape. Week navigation is the opposite case:
 * it moves to a different date range and Back SHOULD step through it (round 1, M2 fixed exactly
 * that, in the other direction).
 *
 * The asymmetry is the thing under test. Pinning only "the toggle replaces" would leave a future
 * "make history handling consistent" edit free to convert the week nav too, silently undoing M2;
 * pinning both halves in one file makes either unification fail here.
 */
describe('CalendarShell — history: view toggle REPLACES, week navigation PUSHES (F4)', () => {
  it('toggling Week -> Agenda replaces the entry and pushes nothing', () => {
    render(<CalendarShell view={pageView()} initialWeekStartDayKey="2026-08-24" />);

    fireEvent.click(screen.getByRole('radio', { name: /agenda/i }));

    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith(
      expect.stringContaining('view=agenda'),
      expect.objectContaining({ scroll: false })
    );
    // The regression: with `push` here, four toggles cost four Back presses to leave the page.
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('toggling repeatedly never grows the history stack', () => {
    render(<CalendarShell view={pageView()} initialWeekStartDayKey="2026-08-24" />);

    fireEvent.click(screen.getByRole('radio', { name: /agenda/i }));
    fireEvent.click(screen.getByRole('radio', { name: /week/i }));
    fireEvent.click(screen.getByRole('radio', { name: /agenda/i }));

    expect(mockPush).not.toHaveBeenCalled();
    expect(mockReplace).toHaveBeenCalledTimes(3);
  });

  it('week navigation still PUSHES — Back must step through weeks (M2 kept)', () => {
    render(<CalendarShell view={pageView()} initialWeekStartDayKey="2026-08-24" />);

    fireEvent.click(screen.getByRole('button', { name: 'Next week' }));

    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith(
      expect.stringContaining('week=2026-08-31'),
      expect.objectContaining({ scroll: false })
    );
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('the two are NOT unified: in one session the toggle replaces and the week nav pushes', () => {
    render(<CalendarShell view={pageView()} initialWeekStartDayKey="2026-08-24" />);

    fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
    fireEvent.click(screen.getByRole('radio', { name: /agenda/i }));

    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush.mock.calls[0]?.[0]).toContain('week=2026-08-31');
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace.mock.calls[0]?.[0]).toContain('view=agenda');
  });
});

/**
 * BAL-498 fix round 5, F5. Both nothing-scheduled copies asserted "Your availability is still
 * visible to clients" unconditionally — false for an expert whose profile is unpublished
 * (`not_published`) or whose availability is unconfigured (`not_configured`), which are exactly
 * the states the shading surface already models and already renders its own note for. The claim
 * is now made only on the one signal that establishes it: the availability endpoint answered
 * `ready`.
 */
describe('CalendarShell — the nothing-scheduled reassurance is only claimed when true (F5)', () => {
  it('kind=ready: the claim is made', () => {
    mockAvailabilityView = {
      kind: 'ready',
      expertTimezone: 'Australia/Sydney',
      days: 7,
      slots: [
        { start: '2026-08-25T00:00:00.000Z', end: '2026-08-25T02:00:00.000Z', maxDuration: 60 },
      ],
    };
    render(<CalendarShell view={pageView({ meetings: [] })} initialWeekStartDayKey="2026-08-24" />);

    expect(screen.getByText(/Your availability is still visible to clients/i)).toBeInTheDocument();
  });

  it.each(NON_READY_VIEWS)(
    'kind=%s: the claim is DROPPED, and the invitation-framed half survives',
    (_kind, availability) => {
      mockAvailabilityView = availability;
      render(
        <CalendarShell view={pageView({ meetings: [] })} initialWeekStartDayKey="2026-08-24" />
      );

      // The regression: before F5 this asserted "your availability is still visible to clients"
      // to an expert whose profile is not even published.
      expect(
        screen.queryByText(/Your availability is still visible to clients/i)
      ).not.toBeInTheDocument();
      // Still invitation-framed, never absence-framed (CLAUDE.md's empty-state rule).
      expect(
        screen.getByText(/Bookings will show up here as soon as someone schedules time with you/i)
      ).toBeInTheDocument();
    }
  );

  it('Agenda mounts no shading query at all, so it never claims it either', () => {
    mockSearchParams = new URLSearchParams('view=agenda');
    mockAvailabilityView = {
      kind: 'ready',
      expertTimezone: 'Australia/Sydney',
      days: 7,
      slots: [
        { start: '2026-08-25T00:00:00.000Z', end: '2026-08-25T02:00:00.000Z', maxDuration: 60 },
      ],
    };
    render(<CalendarShell view={pageView({ meetings: [] })} initialWeekStartDayKey="2026-08-24" />);

    expect(mockUseExpertAvailability).not.toHaveBeenCalled();
    expect(
      screen.queryByText(/Your availability is still visible to clients/i)
    ).not.toBeInTheDocument();
    expect(screen.getByText(/You're all clear/i)).toBeInTheDocument();
  });
});

describe('CalendarShell — mobile default view', () => {
  it('defaults to Agenda on mobile when no ?view= is present', () => {
    isMobile = true;
    render(<CalendarShell view={pageView()} initialWeekStartDayKey="2026-08-24" />);

    expect(screen.getByRole('radio', { name: /agenda/i })).toHaveAttribute('aria-checked', 'true');
  });
});

describe('CalendarShell — WeekNav mounted only in Week view', () => {
  it('WeekNav is absent in Agenda view', () => {
    mockSearchParams = new URLSearchParams('view=agenda');
    render(<CalendarShell view={pageView()} initialWeekStartDayKey="2026-08-24" />);

    expect(screen.queryByRole('button', { name: 'Today' })).not.toBeInTheDocument();
  });
});

/**
 * BAL-511 (D9). The collapse is pure CSS (`sm:` utilities) and jsdom applies no stylesheets, so
 * "assert the accessible name at both viewports" is unfalsifiable as the ticket originally wrote
 * it — the `sr-only` label is in the accessible name at every viewport either way. `useIsMobile`
 * is also the wrong lever here: `hooks/use-mobile.ts` defaults to a 1024px breakpoint, not `sm`
 * (640px), and this shell uses it only to pick the DEFAULT view — flipping the mock swaps
 * Week↔Agenda and unmounts the grid while leaving this button byte-identical. What is pinned
 * instead: the accessible name is exactly "Edit availability", `CalendarDays` always renders, the
 * label carries the `sm:`-scoped visibility classes, and a click still fires the unchanged
 * analytics event. `<Button asChild>` renders an `<a>`, so every query below is `getByRole('link'
 * , …)`, never `getByRole('button', …)`.
 */
describe('CalendarShell — the "Edit availability" header action (BAL-511)', () => {
  it('reads "Edit availability" to assistive tech and points at the schedule settings deep link', () => {
    render(<CalendarShell view={pageView()} initialWeekStartDayKey="2026-08-24" />);

    const action = screen.getByRole('link', { name: 'Edit availability' });
    expect(action).toHaveAttribute('href', '/expert/settings?tab=schedule');
  });

  it('collapses to icon-only below sm without ever dropping the label from the a11y tree', () => {
    render(<CalendarShell view={pageView()} initialWeekStartDayKey="2026-08-24" />);

    const label = screen.getByText('Edit availability');
    expect(label.className).toContain('sr-only');
    expect(label.className).toContain('sm:not-sr-only');
    const action = screen.getByRole('link', { name: 'Edit availability' });
    expect(action.className).toContain('w-11');
    expect(action.className).toContain('sm:w-auto');
    expect(action.className).toContain('min-h-11'); // the 44px minimum survives the collapse
    // ⚠ THE ICON IS THE WHOLE CONTROL BELOW `sm`. The docblock claims `CalendarDays` always
    // renders; without this assertion nothing enforced it, and deleting the icon left all three
    // tests green while the button rendered as an empty 44px box to a sighted mobile user (the
    // label being `sr-only` there). Pinned as presence, not identity — swapping the glyph is a
    // design call, rendering NOTHING is a bug.
    expect(action.querySelector('svg')).not.toBeNull();
  });

  it('the collapsed control still fires calendar_edit_availability_clicked { source: "header" }', () => {
    render(<CalendarShell view={pageView()} initialWeekStartDayKey="2026-08-24" />);

    fireEvent.click(screen.getByRole('link', { name: 'Edit availability' }));

    expect(mockTrack).toHaveBeenCalledWith(CALENDAR_EVENTS.EDIT_AVAILABILITY_CLICKED, {
      source: 'header',
    });
  });
});

describe('CalendarShell — calendar_viewed carries week_offset (BAL-512)', () => {
  // FIXED_NOW is Monday 2026-08-24 in Australia/Sydney, so that IS the current week.
  const CASES: [label: string, weekStart: string, expected: number][] = [
    ['this week', '2026-08-24', 0],
    ['a deep-linked ?week= two weeks ahead', '2026-09-07', 2],
    ['a past week', '2026-08-10', -2],
  ];

  it.each(CASES)('%s (week of %s) → week_offset %s', (_label, weekStart, expected) => {
    render(<CalendarShell view={pageView()} initialWeekStartDayKey={weekStart} />);

    expect(mockTrack).toHaveBeenCalledWith(CALENDAR_EVENTS.VIEWED, {
      view: 'week',
      source: 'initial',
      week_offset: expected,
    });
  });
});

describe('CalendarShell — the contextual nudges are instrumented (BAL-512)', () => {
  it('the banner’s connect link fires exactly one calendar_connect_cta_clicked { source: "banner" }, and no upkeep event', () => {
    // M5 — the banner renders only inside the `!showFullPageConnectEmptyState` branch, so it
    // needs no connected calendar AND at least one meeting. Same setup as the A5 test above.
    render(
      <CalendarShell
        view={pageView({ hasConnectedCalendar: false, meetings: [meeting()] })}
        initialWeekStartDayKey="2026-08-24"
      />
    );
    mockTrack.mockClear(); // drop the mount's calendar_viewed

    fireEvent.click(screen.getByRole('link', { name: /Set up your calendar connection/i }));

    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith(CALENDAR_EVENTS.CONNECT_CTA_CLICKED, {
      source: 'banner',
    });
  });

  it('the not-configured note’s link fires calendar_edit_availability_clicked { source: "not_configured_note" } and points at its OWN destination', () => {
    // M5 — this note renders in WEEK view only (`availabilityView` resets to null off Week).
    mockAvailabilityView = { kind: 'not_configured' };
    render(<CalendarShell view={pageView()} initialWeekStartDayKey="2026-08-24" />);
    mockTrack.mockClear();

    const link = screen.getByRole('link', { name: /Set your availability/i });
    // M4 — the two surviving EDIT_AVAILABILITY_CLICKED sources point at DIFFERENT destinations.
    // Pinned here so the "they share one destination" claim cannot creep back into the docblock.
    expect(link).toHaveAttribute('href', '/expert/settings?tab=schedule&setup=availability');

    fireEvent.click(link);

    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith(CALENDAR_EVENTS.EDIT_AVAILABILITY_CLICKED, {
      source: 'not_configured_note',
    });
  });
});

/**
 * BAL-512 week navigation.
 *
 * ⚠ THE `rerender` CALLS ARE LOAD-BEARING AND THE COMPONENT IS CORRECT — do not "fix" it.
 * `initialWeekStartDayKey` is a SERVER prop (`page.tsx:105`) and `WeekNav` derives its
 * destination from it. `useRouter` is mocked here (`:49`), so `router.push` never triggers the
 * RSC round trip that would hand the shell a new prop. Without an explicit `rerender` between
 * clicks, two consecutive "Previous week" clicks both compute -1 — an artefact of the mock, not
 * of the shell. Each `rerender` below stands in for exactly one push → RSC response.
 */
describe('CalendarShell — week navigation analytics (BAL-512)', () => {
  /** Just the `calendar_week_navigated` payloads, in emission order. */
  function weekNavPayloads(): unknown[] {
    return mockTrack.mock.calls
      .filter(([name]) => name === CALENDAR_EVENTS.WEEK_NAVIGATED)
      .map(([, props]) => props);
  }

  it('paging two weeks back then pressing Today yields offsets -1, -2, 0 (AC)', () => {
    const { rerender } = render(
      <CalendarShell view={pageView()} initialWeekStartDayKey="2026-08-24" />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Previous week' }));
    rerender(<CalendarShell view={pageView()} initialWeekStartDayKey="2026-08-17" />);

    fireEvent.click(screen.getByRole('button', { name: 'Previous week' }));
    rerender(<CalendarShell view={pageView()} initialWeekStartDayKey="2026-08-10" />);

    // Now two weeks back, so Today is live (not aria-disabled).
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));

    expect(weekNavPayloads()).toEqual([
      { direction: 'previous', week_offset: -1 },
      { direction: 'previous', week_offset: -2 },
      { direction: 'today', week_offset: 0 },
    ]);
    // Paging weeks is not a new VIEW: `viewedRef` keeps calendar_viewed at exactly one for the
    // whole lifecycle, even though `weekOffset` now sits in that effect's deps.
    expect(mockTrack.mock.calls.filter(([name]) => name === CALENDAR_EVENTS.VIEWED)).toHaveLength(
      1
    );
  });

  it('Next week from the current week fires { direction: "next", week_offset: 1 }', () => {
    render(<CalendarShell view={pageView()} initialWeekStartDayKey="2026-08-24" />);

    fireEvent.click(screen.getByRole('button', { name: 'Next week' }));

    expect(weekNavPayloads()).toEqual([{ direction: 'next', week_offset: 1 }]);
  });

  /**
   * The documented semantic, pinned. `direction` names the DESTINATION, not the button: a
   * Previous click from next week lands on the current week and is reported `'today'`. Both
   * routes to offset 0 must agree, or `direction` and `week_offset` could contradict each other
   * in PostHog. `WeekNav` stays dumb (`onNavigate(dayKey)`), which is what makes this the rule.
   */
  it('direction === "today" ⟺ week_offset === 0, whichever affordance got there', () => {
    // Route A — Previous week, pressed from the week AFTER this one.
    const { unmount } = render(
      <CalendarShell view={pageView()} initialWeekStartDayKey="2026-08-31" />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Previous week' }));
    expect(weekNavPayloads()).toEqual([{ direction: 'today', week_offset: 0 }]);
    unmount();
    mockTrack.mockClear();

    // Route B — the Today button, pressed from a week that does not contain today.
    render(<CalendarShell view={pageView()} initialWeekStartDayKey="2026-09-21" />);
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    expect(weekNavPayloads()).toEqual([{ direction: 'today', week_offset: 0 }]);
  });

  it('the Today button is inert on the current week, so it emits nothing', () => {
    render(<CalendarShell view={pageView()} initialWeekStartDayKey="2026-08-24" />);

    const today = screen.getByRole('button', { name: 'Today' });
    expect(today).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(today);

    expect(weekNavPayloads()).toEqual([]);
    expect(mockPush).not.toHaveBeenCalled();
  });
});
