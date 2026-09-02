/**
 * BAL-511 — the 60-second tick must not re-render the whole week grid.
 *
 * ⚠ A SEPARATE FILE, NOT `calendar-shell.test.tsx`. `vi.mock` is hoisted and FILE-SCOPED, so
 * mocking `./meeting-block` there would replace the real component for that file's ~45 tests and
 * break at least the "Join appears/disappears with the 60-second tick" test (`getByRole('button',
 * { name: /Join/i })`) and the empty-state tests (`getByText('Northwind')`), both of which are
 * rendered by `MeetingBlock`.
 *
 * ⚠ THE STUB IS DELIBERATELY NOT MEMOISED, AND THE ASSERTION IS ON PROPS, NOT RENDER COUNTS.
 * A memoised counting wrapper would measure the WRAPPER's memo and pass even if `MeetingBlock`
 * itself were a plain function. Prop-set equality under `Object.is` IS React.memo's default
 * comparison — so "props identical across a tick" + "the export is React.memo"
 * (`meeting-block.test.tsx`) is exactly "no re-render", proved in two halves neither of which can
 * pass vacuously (BAL-511 D19 — the architect's correction to the earlier "counting wrapper" plan).
 *
 * TZ=UTC required (memory `reference_web_tests_need_tz_utc`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@/test/utils';
import { CalendarShell } from './calendar-shell';
import type { CalendarPageView, CalendarMeetingView } from '../_lib/calendar-view-types';
import type { AvailabilityView } from '@/components/availability/use-expert-availability';
import { CALENDAR_EVENTS } from '@/lib/analytics';

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});

let mockSearchParams = new URLSearchParams();
const mockPush = vi.fn();
const mockReplace = vi.fn();
const mockRefresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace, refresh: mockRefresh }),
  useSearchParams: () => mockSearchParams,
}));

let isMobile = false;
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => isMobile }));

const mockReload = vi.fn();
// ⚠ `LOADING_VIEW` is a MODULE-LEVEL CONSTANT, deliberately, matching `calendar-shell.test.tsx`'s
// own `mockAvailabilityView` pattern: a fresh object literal returned on every hook call breaks
// referential stability of `view`, and `AvailabilityShading`'s `useEffect([view])` re-fires
// `onViewChange` on every render — an infinite render loop under fake timers that no assertion
// ever reaches (it hangs the test run rather than failing it).
const LOADING_VIEW: AvailabilityView = { kind: 'loading' };
vi.mock('@/components/availability/use-expert-availability', () => ({
  useExpertAvailability: () => ({ view: LOADING_VIEW, reload: mockReload }),
}));

const mockTrack = vi.fn();
vi.mock('@/lib/analytics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/analytics')>();
  return { ...actual, track: (...args: unknown[]) => mockTrack(...args) };
});

/** The props-recording, deliberately UN-memoised stub. Same directory as `week-grid.tsx`'s own
 *  import of `./meeting-block`, so both resolve to this mock. */
type BlockProps = Record<string, unknown> & { meeting: { meetingId: string } };
const recorded: BlockProps[] = [];
vi.mock('./meeting-block', () => ({
  MeetingBlock: (props: BlockProps) => {
    recorded.push(props);
    return (
      <button
        type="button"
        data-testid={`block-${props.meeting.meetingId}`}
        onClick={() => (props.onJoinClick as (m: unknown) => void)(props.meeting)}
      />
    );
  },
}));

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

/** Every recorded props object for a given meeting id, in render order. */
function propsFor(meetingId: string): BlockProps[] {
  return recorded.filter((p) => p.meeting.meetingId === meetingId);
}

/** Every prop key whose value is not `Object.is`-identical between two renders — i.e. exactly what
 *  React.memo's default comparator looks at. Returns the offending NAMES so a failure says which
 *  prop broke the memo, not merely that one did. */
function changedProps(before: BlockProps, after: BlockProps): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => !Object.is(before[key], after[key])).sort();
}

const FIXED_NOW = new Date('2026-08-24T00:00:00.000Z'); // Monday 10:00 AEST

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  mockSearchParams = new URLSearchParams();
  isMobile = false;
  mockPush.mockClear();
  mockReplace.mockClear();
  mockRefresh.mockClear();
  mockTrack.mockClear();
  mockReload.mockClear();
  recorded.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CalendarShell + WeekGrid — a tick crossing no boundary changes nothing', () => {
  it('re-renders the block (the grid DID re-render) but every prop is Object.is-identical', () => {
    const far = meeting({
      meetingId: 'far',
      scheduledStart: new Date(FIXED_NOW.getTime() + 3 * 60 * 60_000).toISOString(),
      scheduledEnd: new Date(FIXED_NOW.getTime() + 3.5 * 60 * 60_000).toISOString(),
    });
    render(
      <CalendarShell view={pageView({ meetings: [far] })} initialWeekStartDayKey="2026-08-24" />
    );

    const before = propsFor('far').at(-1);
    expect(before).toBeDefined();
    recorded.length = 0;

    vi.setSystemTime(new Date(FIXED_NOW.getTime() + 60_000));
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    const afterList = propsFor('far');
    // Non-vacuity: the stub DID re-render (the grid re-rendered on the tick; only the real
    // memo would have stopped the CHILD from re-rendering).
    expect(afterList.length).toBeGreaterThan(0);
    const after = afterList.at(-1);
    expect(after).toBeDefined();
    if (before === undefined || after === undefined) throw new Error('unreachable');
    expect(changedProps(before, after)).toEqual([]);
  });
});

describe('CalendarShell + WeekGrid — a tick crossing the Join boundary changes exactly that block', () => {
  it('only the boundary-crossing meeting changes props; the distant one does not', () => {
    // 20 minutes out is OUTSIDE the 15-minute window; 20 - 15 = 5, so minute 6 is inside it — the
    // same arithmetic `calendar-shell.test.tsx`'s own fake-timer Join test uses.
    const soon = meeting({
      meetingId: 'soon',
      scheduledStart: new Date(FIXED_NOW.getTime() + 20 * 60_000).toISOString(),
      scheduledEnd: new Date(FIXED_NOW.getTime() + 50 * 60_000).toISOString(),
    });
    const far = meeting({
      meetingId: 'far',
      scheduledStart: new Date(FIXED_NOW.getTime() + 3 * 60 * 60_000).toISOString(),
      scheduledEnd: new Date(FIXED_NOW.getTime() + 3.5 * 60 * 60_000).toISOString(),
    });
    render(
      <CalendarShell
        view={pageView({ meetings: [soon, far] })}
        initialWeekStartDayKey="2026-08-24"
      />
    );

    const beforeSoon = propsFor('soon').at(-1);
    const beforeFar = propsFor('far').at(-1);
    expect(beforeSoon).toBeDefined();
    expect(beforeFar).toBeDefined();
    recorded.length = 0;

    vi.setSystemTime(new Date(FIXED_NOW.getTime() + 6 * 60_000));
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    const afterSoon = propsFor('soon').at(-1);
    const afterFar = propsFor('far').at(-1);
    if (
      beforeSoon === undefined ||
      beforeFar === undefined ||
      afterSoon === undefined ||
      afterFar === undefined
    ) {
      throw new Error('unreachable');
    }
    expect(changedProps(beforeSoon, afterSoon)).toEqual(['joinTimingLabel', 'joinVisible']);
    expect(changedProps(beforeFar, afterFar)).toEqual([]);
  });
});

describe('CalendarShell + WeekGrid — onJoinClick identity survives a tick', () => {
  it('the same handler reference is handed down before and after a tick', () => {
    const far = meeting({
      meetingId: 'far',
      scheduledStart: new Date(FIXED_NOW.getTime() + 3 * 60 * 60_000).toISOString(),
      scheduledEnd: new Date(FIXED_NOW.getTime() + 3.5 * 60 * 60_000).toISOString(),
    });
    render(
      <CalendarShell view={pageView({ meetings: [far] })} initialWeekStartDayKey="2026-08-24" />
    );

    const before = propsFor('far').at(-1);
    expect(before).toBeDefined();
    recorded.length = 0;

    vi.setSystemTime(new Date(FIXED_NOW.getTime() + 60_000));
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    const after = propsFor('far').at(-1);
    if (before === undefined || after === undefined) throw new Error('unreachable');
    expect(after.onJoinClick).toBe(before.onJoinClick);
  });
});

describe('CalendarShell — calendar_join_clicked stays byte-identical and reads the TICKED now', () => {
  it('emits the same payload it always did, from the ticked now (not wall-clock)', () => {
    // meeting starts FIXED_NOW + 10 minutes → inside the 15-minute window immediately.
    const soon = meeting({
      meetingId: 'soon',
      scheduledStart: new Date(FIXED_NOW.getTime() + 10 * 60_000).toISOString(),
      scheduledEnd: new Date(FIXED_NOW.getTime() + 40 * 60_000).toISOString(),
    });
    render(
      <CalendarShell view={pageView({ meetings: [soon] })} initialWeekStartDayKey="2026-08-24" />
    );

    fireEvent.click(screen.getByTestId('block-soon'));
    expect(mockTrack).toHaveBeenCalledWith(CALENDAR_EVENTS.JOIN_CLICKED, {
      view: 'week',
      context_type: 'case',
      minutes_to_start: 10,
    });

    // Wall-clock moves but NO tick fires: the payload must not move either. `new Date()` at click
    // time would report 6 here — the exact regression the ref must not introduce.
    mockTrack.mockClear();
    vi.setSystemTime(new Date(FIXED_NOW.getTime() + 4 * 60_000));
    fireEvent.click(screen.getByTestId('block-soon'));
    expect(mockTrack).toHaveBeenCalledWith(CALENDAR_EVENTS.JOIN_CLICKED, {
      view: 'week',
      context_type: 'case',
      minutes_to_start: 10,
    });

    // ...and once the tick DOES fire, it follows.
    // ⚠ THE INTERVAL IS NOT "OVERDUE" HERE — DO NOT "CORRECT" THE 5 BELOW TO A 6.
    // @sinonjs/fake-timers' `setSystemTime` shifts every PENDING timer's `callAt` by the same
    // delta as the clock, so the jump to FIXED_NOW+4min carried the 60s interval along with it:
    // it is still a full minute out, not one minute late. Advancing by 60s therefore fires it at
    // FIXED_NOW+5min (not +6min, which is what you get if you assume the jump left it overdue),
    // and `now` is genuinely driven by the tick rather than by `new Date()`. The plan's worked
    // example assumed no shift and predicted 6; 5 is correct and is verified by mutation — swap
    // `nowRef.current` back to `new Date()` and this same click reports 6.
    mockTrack.mockClear();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    fireEvent.click(screen.getByTestId('block-soon'));
    expect(mockTrack).toHaveBeenCalledWith(CALENDAR_EVENTS.JOIN_CLICKED, {
      view: 'week',
      context_type: 'case',
      minutes_to_start: 5,
    });
  });
});
