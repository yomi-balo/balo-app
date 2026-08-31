'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { CalendarDays } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useIsMobile } from '@/hooks/use-mobile';
import { track, CALENDAR_EVENTS } from '@/lib/analytics';
import type { AvailabilityView } from '@/components/availability/use-expert-availability';
import { MAX_AVAILABILITY_WINDOW_DAYS } from '@balo/shared/availability';
import {
  addDaysToDayKey,
  todayDayKey,
  zonedDayKey,
  zonedMeetingSpan,
  zonedMinutesOfDay,
} from '@/lib/calendar/zoned-grid';
import { signedMinutesUntilCalendarStart } from '@/lib/calendar/join-window';
import type { CalendarPageView, CalendarMeetingView } from '../_lib/calendar-view-types';
import { CalendarViewSwitcher, type CalendarViewMode } from './calendar-view-switcher';
import { WeekNav } from './week-nav';
import { WeekGrid } from './week-grid';
import { AgendaList } from './agenda-list';
import { AvailabilityShading } from './availability-shading';
import { TimezoneChip } from './timezone-chip';
import { NoCalendarConnectedEmptyState, NothingScheduledEmptyState } from './calendar-empty-states';

interface CalendarShellProps {
  readonly view: CalendarPageView;
  readonly initialWeekStartDayKey: string;
}

const NOW_TICK_MS = 60_000;
const EDIT_AVAILABILITY_HREF = '/expert/settings?tab=schedule';
const CONNECT_CALENDAR_HREF = '/expert/settings?tab=schedule&setup=calendar';
const SET_AVAILABILITY_HREF = '/expert/settings?tab=schedule&setup=availability';

/**
 * D3 §7.3 — the number of days (`1..MAX_AVAILABILITY_WINDOW_DAYS`) to request from the
 * availability endpoint for the VISIBLE week, or `null` when there is nothing to shade. A week
 * that starts INSIDE the resolver's 14-day horizon but ends outside it is CLAMPED, not abandoned
 * — the days that ARE inside the horizon still get shaded (BAL-498 fix round 1, H5). A week whose
 * START is already beyond the horizon has no partial coverage to salvage and must NOT be clamped
 * into a request for days outside the visible week entirely (BAL-498 fix round 2, N3 — the prior
 * unconditional clamp re-created the "note says shaded, grid shows nothing" contradiction from a
 * different direction, and mislabelled every day "No availability set" to screen readers).
 * `beyondHorizon` tells the caller whether to show the "later weeks" disclosure note;
 * `isPastWeek` tells it to show the past-week note instead — D3/ruling 6 forbid an unshaded grid
 * with NO explanation at all.
 */
function shadingRequestWindow(
  weekStartDayKey: string,
  now: Date,
  timezone: string
): { days: number | null; beyondHorizon: boolean; isPastWeek: boolean } {
  const weekEndDayKey = addDaysToDayKey(weekStartDayKey, 6);
  const todayKey = todayDayKey(timezone, now);
  const msPerDay = 86_400_000;
  const weekEndDate = new Date(`${weekEndDayKey}T00:00:00.000Z`);
  const todayDate = new Date(`${todayKey}T00:00:00.000Z`);
  // Days from today through the visible week's END, inclusive.
  const rawDays = Math.ceil((weekEndDate.getTime() - todayDate.getTime()) / msPerDay) + 1;
  if (rawDays < 1) {
    return { days: null, beyondHorizon: false, isPastWeek: true };
  }
  // Days from today through the visible week's START, inclusive — `rawDays` measured 6 days
  // earlier (weekStart = weekEnd - 6).
  const weekStartOffsetDays = rawDays - 6;
  if (weekStartOffsetDays > MAX_AVAILABILITY_WINDOW_DAYS) {
    return { days: null, beyondHorizon: true, isPastWeek: false };
  }
  const beyondHorizon = rawDays > MAX_AVAILABILITY_WINDOW_DAYS;
  return {
    days: Math.min(rawDays, MAX_AVAILABILITY_WINDOW_DAYS),
    beyondHorizon,
    isPastWeek: false,
  };
}

/**
 * BAL-498 — the ONE `'use client'` boundary. Owns view state, visible-week state, the single
 * 60-second "now" tick, the `useIsMobile()` default, and mounts the shading child. See
 * plan-bal-498.md § 4 for why the boundary sits here and not lower: the switcher, week nav and
 * grid must share one `now` tick and one visible-week value.
 */
export function CalendarShell({
  view,
  initialWeekStartDayKey,
}: Readonly<CalendarShellProps>): React.JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isMobile = useIsMobile();

  const [viewMode, setViewMode] = useState<CalendarViewMode | null>(() => {
    const requested = searchParams.get('view');
    return requested === 'week' || requested === 'agenda' ? requested : null;
  });
  const [now, setNow] = useState(() => new Date());
  const [availabilityView, setAvailabilityView] = useState<AvailabilityView | null>(null);
  // R4 — the shading sub-surface's retry action. Held in a ref (not state) because the hook's
  // `reload` is already stable and storing a FUNCTION in state needs the `setX(() => fn)`
  // double-wrap footgun; the button's visibility is driven by `availabilityView`, which is state.
  const availabilityReloadRef = useRef<(() => void) | null>(null);
  const handleAvailabilityReload = useCallback(() => {
    availabilityReloadRef.current?.();
  }, []);
  const handleAvailabilityReloadChange = useCallback((reload: () => void) => {
    availabilityReloadRef.current = reload;
  }, []);

  useEffect(() => {
    if (viewMode === null) {
      setViewMode(isMobile ? 'agenda' : 'week');
    }
    // Only resolves the initial null -> default transition; deliberately not re-run on every
    // isMobile flip (the design: reopening the page re-applies the viewport default, a switch
    // mid-session does not force it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile]);

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), NOW_TICK_MS);
    return () => clearInterval(interval);
  }, []);

  const viewedRef = useRef<CalendarViewMode | null>(null);
  useEffect(() => {
    if (viewMode === null) return;
    if (viewedRef.current === viewMode) return;
    const source = viewedRef.current === null ? 'initial' : 'switch';
    viewedRef.current = viewMode;
    track(CALENDAR_EVENTS.VIEWED, { view: viewMode, source });
  }, [viewMode]);

  const handleViewChange = useCallback(
    (next: CalendarViewMode) => {
      setViewMode(next);
      const params = new URLSearchParams(searchParams.toString());
      params.set('view', next);
      // ⚠⚠ `replace`, NOT `push` — AND THE ASYMMETRY WITH `handleWeekNavigate` BELOW IS
      // DELIBERATE (BAL-498 fix round 5, F4). Week↔Agenda is a rendering preference for the SAME
      // data at the SAME instant, so pushing stacked a history entry per toggle and left Back
      // walking through view flips instead of leaving the page. Week navigation is genuine
      // navigation to a different range and keeps `push`. `calendar-shell.test.tsx` pins both
      // halves so a later edit cannot quietly unify them.
      router.replace(`/expert/calendar?${params.toString()}`, { scroll: false });
    },
    [router, searchParams]
  );

  const handleWeekNavigate = useCallback(
    (nextWeekStartDayKey: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set('week', nextWeekStartDayKey);
      if (viewMode !== null) params.set('view', viewMode);
      // `push`, not `replace` — plan §15 requires back-button-correct week navigation. A
      // `replace` here left zero history after paging through several weeks (BAL-498 fix round
      // 1, M2). ⚠ Do NOT "unify" this with `handleViewChange`'s `replace` above: paging weeks is
      // navigation, toggling the view is not (BAL-498 fix round 5, F4).
      router.push(`/expert/calendar?${params.toString()}`, { scroll: false });
    },
    [router, searchParams, viewMode]
  );

  const handleJoinClick = useCallback(
    (meeting: CalendarMeetingView) => {
      // ⚠ UNFLOORED — the analytics contract requires the sign to survive past the scheduled
      // start (BAL-498 fix round 2, N7). `minutesUntilCalendarStart` (floored at 0) drives only
      // the Join aria-label text; never feed it into analytics.
      const minutesToStart = signedMinutesUntilCalendarStart(now, new Date(meeting.scheduledStart));
      track(CALENDAR_EVENTS.JOIN_CLICKED, {
        view: viewMode ?? 'week',
        context_type: meeting.contextType,
        minutes_to_start: minutesToStart,
      });
    },
    [viewMode, now]
  );

  const handleEditAvailabilityClick = useCallback(() => {
    track(CALENDAR_EVENTS.EDIT_AVAILABILITY_CLICKED, { source: 'header' });
  }, []);

  const dayKeys = useMemo(
    () => [0, 1, 2, 3, 4, 5, 6].map((offset) => addDaysToDayKey(initialWeekStartDayKey, offset)),
    [initialWeekStartDayKey]
  );

  const { days, beyondHorizon, isPastWeek } = shadingRequestWindow(
    initialWeekStartDayKey,
    now,
    view.timezone
  );
  // ⚠ NO FALLBACK HERE. `useIsMobile()` returns `false` on first render, always (it resolves
  // `matchMedia` in an effect) — falling back to `isMobile ? 'agenda' : 'week'` while `viewMode`
  // is still `null` would paint the full 7-column Week grid on EVERY phone load for one frame,
  // then snap to Agenda. `resolvedView` stays `null` until the effect above resolves the real
  // default, and the body renders a skeleton for that one tick instead (BAL-498 fix round 1, H7).
  const resolvedView = viewMode;
  const shadingMounted = resolvedView === 'week' && days !== null;
  /**
   * The ONE positive signal that the expert's availability is actually visible to clients: the
   * public availability endpoint answered 200 with bookable slots, which requires the profile to
   * be live AND availability configured AND time genuinely free. Two consumers, deliberately
   * sharing one expression so they cannot drift: the day headers' `aria-describedby` gate
   * (round 4, item 2) and the nothing-scheduled reassurance copy (round 5, F5).
   *
   * ⚠ `shadingMounted` is conjoined because `availabilityView` is only reset to `null` in an
   * effect — for the one render in which the child unmounts it can still hold a stale `ready`.
   */
  const availabilityVisibleToClients = shadingMounted && availabilityView?.kind === 'ready';

  // The shading child unmounts whenever it falls out of scope (past week, or Agenda). Reset the
  // lifted `availabilityView` in step, or the page keeps rendering a note built from the LAST
  // value a now-unmounted child ever reported — e.g. "Shaded time is what clients can still
  // book" alongside "Availability shading covers the next 14 days" with no shading on screen
  // (BAL-498 fix round 1, H4).
  useEffect(() => {
    if (!shadingMounted) {
      setAvailabilityView(null);
      availabilityReloadRef.current = null;
    }
  }, [shadingMounted]);

  const rangeLabel = useMemo(() => {
    const weekEndDayKey = addDaysToDayKey(initialWeekStartDayKey, 6);
    const formatDayKey = (dayKey: string): string => {
      const [year, month, day] = dayKey.split('-').map(Number);
      if (year === undefined || month === undefined || day === undefined) return dayKey;
      return new Intl.DateTimeFormat('en-AU', {
        day: 'numeric',
        month: 'short',
        timeZone: 'UTC',
      }).format(new Date(Date.UTC(year, month - 1, day)));
    };
    const yearLabel = new Intl.DateTimeFormat('en-AU', { year: 'numeric', timeZone: 'UTC' }).format(
      new Date(`${weekEndDayKey}T00:00:00.000Z`)
    );
    return `${formatDayKey(initialWeekStartDayKey)} – ${formatDayKey(weekEndDayKey)}, ${yearLabel}`;
  }, [initialWeekStartDayKey]);

  // One extra day of lookback (the day BEFORE the visible week) so a meeting starting on the
  // previous week's last day but crossing local midnight into the visible Monday is included —
  // `WeekGrid`'s continuation-fragment lookback needs the meeting in its `meetings` prop to have
  // anything to find (BAL-498 fix round 2, suggestion — design line 97's "must not silently
  // disappear" applies at the week boundary too, not only mid-week).
  const previousWeekLookbackDayKey = useMemo(
    () => addDaysToDayKey(initialWeekStartDayKey, -1),
    [initialWeekStartDayKey]
  );
  const weekMeetings = useMemo(
    () =>
      view.meetings.filter((meeting) => {
        const dayKey = zonedDayKey(meeting.scheduledStart, view.timezone);
        return dayKey === previousWeekLookbackDayKey || dayKeys.includes(dayKey);
      }),
    [view.meetings, view.timezone, dayKeys, previousWeekLookbackDayKey]
  );

  const todayKey = todayDayKey(view.timezone, now);
  const agendaMeetings = useMemo(
    () =>
      view.meetings.filter(
        (meeting) => zonedDayKey(meeting.scheduledStart, view.timezone) >= todayKey
      ),
    [view.meetings, view.timezone, todayKey]
  );

  const showFullPageConnectEmptyState = !view.hasConnectedCalendar && view.meetings.length === 0;

  // Lifted from `availabilityView` (reported by the shading child via `onViewChange`) so
  // `WeekGrid` can union the bookable runs into `gridRange` (W1: "meeting spans ∪ the shading
  // runs"). Empty before the child's first fetch resolves — the range simply widens once slots
  // arrive.
  //
  // ⚠ MUST EMIT THE SAME TWO FRAGMENTS `AvailabilityShading` PAINTS (BAL-498 fix round 4, item 1).
  // This is the SECOND derivation of a slot's minute span, and it used to be the pre-R3 arithmetic
  // — `zonedMinutesOfDay` on BOTH ends — while the wash itself fragments at local midnight. For a
  // 22:00→02:00 rule that produced the INVERTED span `{startMinutes: 1320, endMinutes: 120}`, which
  // `computeGridRangeMinutes` widens the grid in NEITHER direction for (1320 is not < 420; 120 is
  // not > 1140). The two painted fragments then landed at `top: 960` — below the bottom of a 768px
  // grid body — and `top: -448`, clipped above a container that cannot scroll negative: R3 fixed
  // the negative height but left a visible band floating outside the grid. Reuses `zonedMeetingSpan`
  // exactly as `week-grid.tsx` already does for meetings, so there is ONE definition of "clipped at
  // local midnight" feeding both the paint and the range.
  const shadingMinuteSpans = useMemo(() => {
    if (availabilityView?.kind !== 'ready') return [];
    return availabilityView.slots.flatMap((slot) => {
      const span = zonedMeetingSpan(slot.start, slot.end, view.timezone);
      if (!span.crossesMidnight) return [span];
      return [span, { startMinutes: 0, endMinutes: zonedMinutesOfDay(slot.end, view.timezone) }];
    });
  }, [availabilityView, view.timezone]);

  // `null` while `resolvedView` has not resolved yet — the skeleton branch below renders instead.
  let bodyContent: React.ReactNode = null;
  if (resolvedView === 'week') {
    bodyContent = (
      <>
        {weekMeetings.length === 0 && (
          <NothingScheduledEmptyState
            view="week"
            availabilityVisibleToClients={availabilityVisibleToClients}
          />
        )}
        <WeekGrid
          weekStartDayKey={initialWeekStartDayKey}
          rangeLabel={rangeLabel}
          timezone={view.timezone}
          meetings={weekMeetings}
          now={now}
          onJoinClick={handleJoinClick}
          isMobile={isMobile}
          shadingMinuteSpans={shadingMinuteSpans}
          // A2 — the day headers may only point `aria-describedby` at the shading's per-day
          // summary ids while those ids EXIST. `AvailabilityShading` renders `null` for every
          // state but `ready`, so "the overlay is mounted" is not the condition; "the overlay is
          // ready" is (BAL-498 fix round 4, item 2). `shadingMounted` is conjoined because
          // `availabilityView` is only reset to `null` in an effect — for the one render in which
          // the child unmounts it can still hold a stale `ready`. (Both conditions now live in
          // the one `availabilityVisibleToClients` expression declared above.)
          shadingDescribesDays={availabilityVisibleToClients}
          // ⚠ THE PROP NAME IS LOAD-BEARING — see `WeekGrid`'s `renderShadingOverlay` doc
          // (BAL-498 fix round 6, item 2). Behaviour, the `shadingMounted` gate and every
          // argument below are unchanged from the `shadingOverlay` spelling.
          renderShadingOverlay={
            shadingMounted
              ? (gridRange, visibleDayKeys) => (
                  <AvailabilityShading
                    expertProfileId={view.expertProfileId}
                    days={days ?? 1}
                    scheduleTimezone={view.timezone}
                    dayKeys={visibleDayKeys}
                    gridRange={gridRange}
                    // R2 — the endpoint's window is `[today, today + days)`. Handing the child
                    // both edges is what lets it say "Past" / "Beyond the availability window"
                    // for days it was never asked about, instead of "No availability set".
                    todayDayKey={todayKey}
                    coverageEndDayKey={addDaysToDayKey(todayKey, (days ?? 1) - 1)}
                    onViewChange={setAvailabilityView}
                    onReloadChange={handleAvailabilityReloadChange}
                  />
                )
              : undefined
          }
        />
      </>
    );
  } else if (resolvedView === 'agenda') {
    bodyContent =
      agendaMeetings.length === 0 ? (
        // ⚠ `availabilityVisibleToClients` is deliberately NOT passed here. Agenda mounts no
        // shading child, so the shell holds no evidence either way and must not assert the
        // claim — the prop defaults to `false` and the copy drops to its universally-true half
        // (round 5, F5). Do not "fix" this by widening the shading query to Agenda.
        <NothingScheduledEmptyState view="agenda" />
      ) : (
        <AgendaList
          meetings={agendaMeetings}
          timezone={view.timezone}
          now={now}
          onJoinClick={handleJoinClick}
        />
      );
  }

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-foreground text-2xl font-semibold">Calendar</h1>
          <div className="mt-1">
            <TimezoneChip scheduleTimezone={view.timezone} />
          </div>
        </div>
        {/* R5 — `next/link`: an ordinary in-app route, so a full document reload here was never
            justified by the tokenless-join-URL rule (which applies only to the Join affordance,
            now a button entirely). */}
        <Button asChild variant="outline" onClick={handleEditAvailabilityClick}>
          <Link href={EDIT_AVAILABILITY_HREF}>
            <CalendarDays className="h-4 w-4" aria-hidden="true" />
            Edit availability
          </Link>
        </Button>
      </div>

      {resolvedView === null ? (
        // ⚠ H7 — the ONE extra tick before `viewMode` resolves (see the comment above
        // `resolvedView`). No flash of the wrong view: neither the switcher (it needs a definite
        // `view` value) nor the grid/agenda body render until the real default is known.
        <CalendarBodySkeleton />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <CalendarViewSwitcher view={resolvedView} onChange={handleViewChange} />
            {resolvedView === 'week' && (
              <WeekNav
                weekStartDayKey={initialWeekStartDayKey}
                todayDayKey={todayKey}
                rangeLabel={rangeLabel}
                onNavigate={handleWeekNavigate}
              />
            )}
          </div>

          {showFullPageConnectEmptyState ? (
            <NoCalendarConnectedEmptyState href={CONNECT_CALENDAR_HREF} />
          ) : (
            <div>
              {/* ⚠ `text-warning`, NOT `text-warning-foreground` (C2). In `globals.css`'s `.dark`
                  block `--warning-foreground` is byte-identical to `--background`, so over this
                  10% tint the text painted background-coloured — invisible. `-foreground` is only
                  legible over SOLID `bg-warning`; all eight repo precedents for the tint use
                  `text-warning` with a `border-warning/30` edge.
                  ⚠ COPY IS NEUTRAL (A5): `hasConnectedCalendar` is one boolean
                  (`checklist.items.calendar`) that cannot tell "never connected" from
                  "credential revoked", so it must not assert either — "Reconnect your calendar"
                  was addressed at an expert who may never have connected one, while the
                  full-page state on the SAME signal correctly says "Connect". */}
              {!view.hasConnectedCalendar && (
                <p className="text-warning border-warning/30 bg-warning/10 mb-3 rounded-md border px-3 py-2 text-sm">
                  Balo isn&apos;t connected to your calendar right now.{' '}
                  <Link href={CONNECT_CALENDAR_HREF} className="font-medium underline">
                    Set up your calendar connection
                  </Link>{' '}
                  to keep availability shading accurate. Your existing bookings are unaffected.
                </p>
              )}
              {availabilityView?.kind === 'not_published' && (
                <p className="text-muted-foreground mb-3 text-sm">
                  Availability shading appears once your profile is live.
                </p>
              )}
              {availabilityView?.kind === 'not_configured' && (
                <p className="text-muted-foreground mb-3 text-sm">
                  <Link href={SET_AVAILABILITY_HREF} className="underline">
                    Set your availability
                  </Link>{' '}
                  to see shading here.
                </p>
              )}
              {view.hasConnectedCalendar && availabilityView?.kind === 'unavailable' && (
                <p className="text-warning border-warning/30 bg-warning/10 mb-3 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm">
                  <span>
                    Your calendar connection needs attention — availability shown may be out of
                    date.
                  </span>
                  <AvailabilityRetryButton onRetry={handleAvailabilityReload} />
                </p>
              )}
              {availabilityView?.kind === 'empty_window' && (
                <p className="text-muted-foreground mb-3 text-sm">
                  No bookable time in this window right now.
                </p>
              )}
              {/* Both gated on `resolvedView === 'week'` — Agenda has no shading concept at all,
                  and these two are computed directly from the visible week (not from
                  `availabilityView`, which already resets to `null` off Week), so nothing else
                  hides them there (BAL-498 fix round 2, N4). */}
              {resolvedView === 'week' && beyondHorizon && (
                <p className="text-muted-foreground mb-3 text-sm">
                  Availability shading covers the next {MAX_AVAILABILITY_WINDOW_DAYS} days. Later
                  weeks show your bookings only.
                </p>
              )}
              {resolvedView === 'week' && isPastWeek && (
                <p className="text-muted-foreground mb-3 text-sm">
                  This week is in the past, so availability shading isn&apos;t shown — only your
                  bookings.
                </p>
              )}
              {/* R4 — the FOURTH state. Loading previously rendered nothing at all, so the grid
                  painted unshaded with no indication and the wash popped in later; the four-states
                  rule applies to this sub-surface too. */}
              {availabilityView?.kind === 'loading' && (
                <p className="text-muted-foreground mb-3 text-sm">Loading your available hours…</p>
              )}
              {availabilityView?.kind === 'ready' && (
                <p className="text-muted-foreground mb-3 text-sm">
                  Shaded time is what clients can still book — your booked meetings sit on top.
                </p>
              )}
              {availabilityView?.kind === 'error' && (
                <p
                  role="alert"
                  className="text-destructive mb-3 flex flex-wrap items-center gap-2 text-sm"
                >
                  <span>
                    We couldn&apos;t load your availability shading. Your calendar itself is
                    unaffected.
                  </span>
                  <AvailabilityRetryButton onRetry={handleAvailabilityReload} />
                </p>
              )}

              {bodyContent}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * R4 — the retry action balo-ui `layouts-states.md` requires on every error state. Shared by the
 * `error` and `unavailable` notes so the two cannot drift apart; both re-run the SAME
 * `useExpertAvailability.reload` the shading child lifts up, which is what the hook already
 * exposes (and what the previous implementation discarded by destructuring only `{ view }`).
 */
function AvailabilityRetryButton({
  onRetry,
}: Readonly<{ onRetry: () => void }>): React.JSX.Element {
  return (
    <Button type="button" variant="outline" size="sm" className="min-h-11" onClick={onRetry}>
      Try again
    </Button>
  );
}

/** The ONE extra tick before `viewMode` resolves. Deliberately minimal — this renders for a
 *  single frame, never long enough to need the full `loading.tsx` treatment. */
function CalendarBodySkeleton(): React.JSX.Element {
  return (
    <output aria-label="Loading calendar" className="block">
      <div className="bg-muted mb-4 inline-flex h-10 w-40 animate-pulse rounded-xl" />
      <div className="border-border bg-card h-64 animate-pulse rounded-xl border" />
      <span className="sr-only">Loading…</span>
    </output>
  );
}
