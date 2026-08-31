'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  addDaysToDayKey,
  zonedDayKey,
  zonedMeetingSpan,
  zonedMinutesOfDay,
  formatDayColumnHeading,
  todayDayKey,
} from '@/lib/calendar/zoned-grid';
import {
  PX_PER_MINUTE,
  GUTTER_WIDTH_PX,
  MIN_OVERLAP_COLUMN_WIDTH_PX,
  computeGridRangeMinutes,
  assignOverlapColumns,
} from '@/lib/calendar/grid-geometry';
import { Button } from '@/components/ui/button';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { calendarMeetingTiming } from '@/lib/calendar/join-window';
import { MeetingBlock } from './meeting-block';
import type { CalendarMeetingView } from '../_lib/calendar-view-types';

interface WeekGridProps {
  readonly weekStartDayKey: string;
  /** Human range for the grid's own accessible name (A2) — e.g. `24 Aug – 30 Aug, 2026`.
   *  Falls back to the raw week-start key so the grid is never left unnamed. */
  readonly rangeLabel?: string;
  readonly timezone: string;
  readonly meetings: readonly CalendarMeetingView[];
  readonly now: Date;
  readonly onJoinClick: (meeting: CalendarMeetingView) => void;
  /** Rendered as a full-size absolute overlay beneath the meeting blocks. A RENDER PROP — see
   *  `computeGridRangeMinutes` note below for why. `visibleDayKeys` is the SAME array the grid
   *  itself lays columns out over (one key on mobile, seven on desktop) — the caller MUST use it
   *  for the overlay's day-column math rather than the full seven-day week, or the wash paints as
   *  seven slivers of a single mobile column (BAL-498 fix round 2, N2).
   *
   *  ⚠ THE `render` PREFIX IS LOAD-BEARING, NOT STYLE (BAL-498 fix round 6, item 2). SonarCloud
   *  S6478 is `react/no-unstable-nested-components`, which reports every function returning JSX
   *  that sits inside a component and is passed through a JSX attribute — and whose ONLY
   *  structural escape hatches are `children` and a prop name matching its `propNamePattern`
   *  default of `render*`. Under the old `shadingOverlay` spelling the rule fired on the caller's
   *  inline arrow in `calendar-shell.tsx`, and extracting the overlay into a module-level
   *  component would NOT have cleared it: the arrow delegating to that component is still an
   *  inline function returning JSX under a non-exempt attribute. Renaming is the fix, and it is
   *  also just honest — this prop always WAS a render prop, as the sentence above already said.
   *  Do not rename it back. */
  readonly renderShadingOverlay?: (
    gridRange: { start: number; end: number },
    visibleDayKeys: readonly string[]
  ) => React.ReactNode;
  /** `true` only when `renderShadingOverlay` is ACTUALLY RENDERING its per-day
   *  `calendar-availability-summary-${dayKey}` elements — i.e. the shading is in its `ready`
   *  state. Anything else (`loading`, `error`, `unavailable`, `not_published`, `not_configured`,
   *  `empty_window`) renders `null`, so the ids do not exist and the day headers must not point
   *  at them. ⚠ The overlay being SUPPLIED is NOT the same as the overlay rendering the ids
   *  (BAL-498 fix round 4, item 2) — gating on `renderShadingOverlay !== undefined` emitted seven
   *  dangling IDREFs on every non-`ready` state, including `loading`, which is the FIRST RENDER
   *  OF EVERY WEEK VIEW. axe reports that as `aria-valid-attr-value` *incomplete*, which
   *  `toHaveNoViolations` does not fail on, so no axe pass can catch it for us. */
  readonly shadingDescribesDays?: boolean;
  /** Single source of truth from `CalendarShell` — see plan-bal-498.md § 4 ("one visible-week
   *  value"). Week itself branches to a genuine single-day grid on mobile (Design Principle #5) —
   *  it does NOT read its own `useIsMobile()`. */
  readonly isMobile: boolean;
  /** Minute-of-day spans of the availability shading's bookable runs, lifted up from
   *  `AvailabilityShading` via `CalendarShell`'s `onViewChange`. Unioned into `gridRange` — the
   *  W1 fix instruction was "meeting spans ∪ the shading runs": an expert with no early meetings
   *  but a 06:00 bookable window must not have that wash drawn above `top: 0` in a container that
   *  cannot scroll negative (BAL-498 fix round 2, suggestion). Empty/absent before the shading
   *  child's first fetch resolves — the range simply widens once it does. */
  readonly shadingMinuteSpans?: readonly {
    readonly startMinutes: number;
    readonly endMinutes: number;
  }[];
}

const DAY_OFFSETS = [0, 1, 2, 3, 4, 5, 6] as const;
const HOUR_LABELS = Array.from({ length: 24 }, (_, hour) => hour);
const GRID_MAX_HEIGHT_PX = 640;

interface PositionedMeeting {
  readonly meeting: CalendarMeetingView;
  readonly top: number;
  readonly height: number;
  readonly leftPercent: number;
  readonly widthPercent: number;
  /** `true` for the SECOND (0:00-anchored) fragment of a meeting that crosses local midnight —
   *  it needs its own `key` (the meeting id repeats) and no top border (it reads as a
   *  continuation, not a new event). */
  readonly isContinuationFragment: boolean;
}

/**
 * BAL-498 — the time grid. Renders a genuine SINGLE-DAY grid on mobile (Design Principle #5 — the
 * broken-miniature-of-desktop 7-column shrink is explicitly forbidden), 7 columns on desktop.
 * Meeting blocks are emitted in CHRONOLOGICAL DOM order within each day column (absolute
 * positioning does not reorder the accessibility tree).
 *
 * A meeting spanning local midnight renders TWO linked fragments — one in each day column, both
 * pointing at the same `href`/`joinUrl` — via `zonedMeetingSpan.crossesMidnight` (design line 97:
 * "must not silently disappear or render only once").
 */
export function WeekGrid({
  weekStartDayKey,
  rangeLabel,
  timezone,
  meetings,
  now,
  onJoinClick,
  renderShadingOverlay,
  shadingDescribesDays = false,
  isMobile,
  shadingMinuteSpans = [],
}: Readonly<WeekGridProps>): React.JSX.Element {
  const dayKeys = useMemo(
    () => DAY_OFFSETS.map((offset) => addDaysToDayKey(weekStartDayKey, offset)),
    [weekStartDayKey]
  );
  const today = todayDayKey(timezone, now);

  const [mobileDayKey, setMobileDayKey] = useState<string>(
    () => dayKeys.find((key) => key === today) ?? dayKeys[0] ?? weekStartDayKey
  );
  useEffect(() => {
    setMobileDayKey(dayKeys.find((key) => key === today) ?? dayKeys[0] ?? weekStartDayKey);
    // Re-derives the default day ONLY when the visible week changes (a fresh week nav re-applies
    // "today if in range, else the first day" — mid-week day taps are not overridden by the tick).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStartDayKey]);

  const visibleDayKeys = isMobile ? [mobileDayKey] : dayKeys;

  // Two fragments per cross-midnight meeting: the natural one on its start day, plus a
  // continuation fragment (0:00 -> end-of-span) on the NEXT day, when that next day is itself a
  // visible column. The bucket set includes ONE extra day BEFORE `weekStartDayKey` — not a
  // rendered column, but a lookback source so a meeting starting the previous week's last day
  // and crossing into the visible Monday is found (its natural fragment stays off-screen; only
  // the continuation, on Monday, renders). The caller (`CalendarShell`) widens its `meetings`
  // prop with the matching one-day lookback so such a meeting actually reaches this map.
  const previousWeekLookbackDayKey = addDaysToDayKey(weekStartDayKey, -1);
  const meetingsByDay = useMemo(() => {
    const byDay = new Map<string, PositionedMeeting['meeting'][]>();
    for (const dayKey of [previousWeekLookbackDayKey, ...dayKeys]) {
      byDay.set(dayKey, []);
    }
    for (const meeting of meetings) {
      const dayKey = zonedDayKey(meeting.scheduledStart, timezone);
      const bucket = byDay.get(dayKey);
      if (bucket !== undefined) {
        bucket.push(meeting);
      }
    }
    return byDay;
  }, [dayKeys, previousWeekLookbackDayKey, meetings, timezone]);

  const gridRange = useMemo(() => {
    const meetingSpans = meetings.flatMap((meeting) => {
      const span = zonedMeetingSpan(meeting.scheduledStart, meeting.scheduledEnd, timezone);
      if (!span.crossesMidnight) return [span];
      // Also widen the range for the continuation fragment, which starts at minute 0.
      return [
        span,
        { startMinutes: 0, endMinutes: zonedMinutesOfDay(meeting.scheduledEnd, timezone) },
      ];
    });
    // Union with the shading runs (W1: "meeting spans ∪ the shading runs") — see the
    // `shadingMinuteSpans` prop doc.
    return computeGridRangeMinutes([...meetingSpans, ...shadingMinuteSpans]);
  }, [meetings, timezone, shadingMinuteSpans]);

  const positionedByDay = useMemo(() => {
    const result = new Map<string, PositionedMeeting[]>();
    const peakColumnCountByDay = new Map<string, number>();
    for (const dayKey of dayKeys) {
      const dayMeetings = meetingsByDay.get(dayKey) ?? [];
      // Natural fragments (this day is the meeting's START day).
      const naturalSorted = [...dayMeetings].sort((a, b) =>
        a.scheduledStart.localeCompare(b.scheduledStart)
      );
      const naturalSpans = naturalSorted.map((meeting) =>
        zonedMeetingSpan(meeting.scheduledStart, meeting.scheduledEnd, timezone)
      );

      // Continuation fragments (a PREVIOUS day's meeting crosses into this day's 00:00).
      const previousDayKey = addDaysToDayKey(dayKey, -1);
      const previousDayMeetings = meetingsByDay.get(previousDayKey) ?? [];
      const continuations = previousDayMeetings
        .map((meeting) => ({
          meeting,
          span: zonedMeetingSpan(meeting.scheduledStart, meeting.scheduledEnd, timezone),
        }))
        .filter((entry) => entry.span.crossesMidnight);
      const continuationSpans = continuations.map((entry) => ({
        startMinutes: 0,
        endMinutes: zonedMinutesOfDay(entry.meeting.scheduledEnd, timezone),
      }));

      const allMeetings = [...naturalSorted, ...continuations.map((entry) => entry.meeting)];
      const allSpans = [...naturalSpans, ...continuationSpans];
      const isContinuation = [...naturalSorted.map(() => false), ...continuations.map(() => true)];
      const assignments = assignOverlapColumns(allSpans);

      const positioned = allMeetings.map((meeting, index) => {
        const span = allSpans[index];
        const assignment = assignments[index];
        const continuation = isContinuation[index];
        if (span === undefined || assignment === undefined || continuation === undefined) {
          throw new Error('week-grid: span/assignment index mismatch');
        }
        const top = (span.startMinutes - gridRange.start) * PX_PER_MINUTE;
        const height = Math.max(4, (span.endMinutes - span.startMinutes) * PX_PER_MINUTE);
        const widthPercent = 100 / assignment.columnCount;
        return {
          meeting,
          top,
          height,
          leftPercent: widthPercent * assignment.column,
          widthPercent,
          isContinuationFragment: continuation,
        };
      });
      result.set(dayKey, positioned);
      const peak = assignments.reduce(
        (max, assignment) => Math.max(max, assignment.columnCount),
        1
      );
      peakColumnCountByDay.set(dayKey, peak);
    }
    return { positionedByDay: result, peakColumnCountByDay };
  }, [dayKeys, meetingsByDay, timezone, gridRange]);

  const bodyHeight = (gridRange.end - gridRange.start) * PX_PER_MINUTE;

  const bodyRef = useRef<HTMLDivElement>(null);
  const hasAutoScrolledRef = useRef(false);
  useEffect(() => {
    if (hasAutoScrolledRef.current) return;
    const body = bodyRef.current;
    if (body === null) return;
    hasAutoScrolledRef.current = true;
    const nowMinutes = zonedMinutesOfDay(now.toISOString(), timezone);
    if (nowMinutes < gridRange.start || nowMinutes > gridRange.end) return;
    const nowTop = (nowMinutes - gridRange.start) * PX_PER_MINUTE;
    // "Roughly a third of the way down" (design line 91) — not pinned to the very top, so a
    // little of the PAST hour stays visible for orientation.
    body.scrollTop = Math.max(0, nowTop - GRID_MAX_HEIGHT_PX / 3);
    // Runs once, on mount only — a later `now` tick must not keep yanking manual scroll position.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    // A2 — the grid was a bare `<div>` with no name and no structure, so a screen-reader user
    // landed inside seven unlabelled columns with nothing announcing what they were part of.
    // Round 6 item 4: `<section aria-label>` rather than `<div role="group">`. A named `<section>`
    // IS a `region` landmark — a real element carrying the role, which is what SonarCloud S6819
    // asks for and what A2 wanted in the first place. The accessible NAME is byte-identical, and
    // the per-day `aria-describedby` wiring below is untouched.
    <section
      aria-label={`Week of ${rangeLabel ?? weekStartDayKey}`}
      className="border-border bg-card overflow-hidden rounded-xl border"
    >
      {isMobile && (
        <MobileDayNav
          dayKeys={dayKeys}
          selectedDayKey={mobileDayKey}
          today={today}
          onSelect={setMobileDayKey}
        />
      )}
      <div
        className="grid"
        style={{
          gridTemplateColumns: `${GUTTER_WIDTH_PX}px repeat(${visibleDayKeys.length}, 1fr)`,
        }}
      >
        <div />
        {visibleDayKeys.map((dayKey) => {
          const heading = formatDayColumnHeading(dayKey);
          const isToday = dayKey === today;
          return (
            <div
              key={dayKey}
              // A2 — WIRES the `id`s `AvailabilityShading` has always emitted and nothing ever
              // referenced, so each day's availability summary is announced ATTACHED to its own
              // day rather than as one disconnected seven-sentence block. This pairing is what
              // satisfies "colour is not the only way to convey information" for the wash, which
              // has no other text or icon equivalent. Gated on `shadingDescribesDays` — the
              // overlay actually RENDERING those ids, not merely being supplied (see the prop
              // doc): a dangling `aria-describedby` is worse than none.
              aria-describedby={
                shadingDescribesDays ? `calendar-availability-summary-${dayKey}` : undefined
              }
              className={cn(
                'border-border flex flex-col items-center border-l py-2 text-sm',
                isToday ? 'text-primary font-semibold' : 'text-muted-foreground font-medium'
              )}
            >
              <span>
                {heading.weekday} {heading.dayNumber}
              </span>
              {isToday && (
                <span className="bg-primary mt-1 h-1 w-1 rounded-full" aria-hidden="true" />
              )}
            </div>
          );
        })}
      </div>

      <div
        ref={bodyRef}
        className="relative grid overflow-y-auto"
        style={{
          gridTemplateColumns: `${GUTTER_WIDTH_PX}px repeat(${visibleDayKeys.length}, 1fr)`,
          maxHeight: GRID_MAX_HEIGHT_PX,
        }}
      >
        <div style={{ height: bodyHeight }} className="relative">
          {HOUR_LABELS.map((hour) => {
            const minutes = hour * 60;
            if (minutes < gridRange.start || minutes > gridRange.end) return null;
            return (
              <span
                key={hour}
                className="text-muted-foreground absolute right-1 -translate-y-1/2 text-xs"
                style={{ top: (minutes - gridRange.start) * PX_PER_MINUTE }}
              >
                {formatHourLabel(hour)}
              </span>
            );
          })}
        </div>

        {renderShadingOverlay?.(gridRange, visibleDayKeys)}

        {visibleDayKeys.map((dayKey) => {
          const positioned = positionedByDay.positionedByDay.get(dayKey) ?? [];
          const peakColumnCount = positionedByDay.peakColumnCountByDay.get(dayKey) ?? 1;
          const needsHorizontalScroll = peakColumnCount >= 3;
          const isToday = dayKey === today;
          return (
            <div
              key={dayKey}
              data-day-key={dayKey}
              className={cn(
                'border-border relative border-l',
                needsHorizontalScroll && 'overflow-x-auto'
              )}
              style={{ height: bodyHeight }}
            >
              <div
                className="relative h-full"
                style={
                  needsHorizontalScroll
                    ? { minWidth: peakColumnCount * MIN_OVERLAP_COLUMN_WIDTH_PX }
                    : undefined
                }
              >
                {isToday && <NowLine now={now} timezone={timezone} gridRange={gridRange} />}
                {positioned.map((entry) => {
                  // ⚠ COMPUTED HERE, NOT IN THE CHILD (BAL-511 D1). `MeetingBlock` is
                  // `React.memo`'d; a `now: Date` prop would change every 60 seconds and make the
                  // memo a no-op for every block on the page. These three primitives change only
                  // when a real boundary is crossed.
                  const timing = calendarMeetingTiming(
                    now,
                    new Date(entry.meeting.scheduledStart),
                    new Date(entry.meeting.scheduledEnd)
                  );
                  return (
                    <MeetingBlock
                      key={`${entry.meeting.meetingId}${entry.isContinuationFragment ? '-continuation' : ''}`}
                      meeting={entry.meeting}
                      timezone={timezone}
                      top={entry.top}
                      height={entry.height}
                      leftPercent={entry.leftPercent}
                      widthPercent={entry.widthPercent}
                      isPast={timing.isPast}
                      joinVisible={timing.joinVisible}
                      joinTimingLabel={timing.joinTimingLabel}
                      onJoinClick={onJoinClick}
                      isContinuationFragment={entry.isContinuationFragment}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

interface MobileDayNavProps {
  readonly dayKeys: readonly string[];
  readonly selectedDayKey: string;
  readonly today: string;
  readonly onSelect: (dayKey: string) => void;
}

/** Mobile Week's day-named prev/next chevrons (Design "Mobile Adaptations" section) — steps
 *  within the current 7-day week; crossing into an adjacent week is WeekNav's job. */
function MobileDayNav({
  dayKeys,
  selectedDayKey,
  today,
  onSelect,
}: Readonly<MobileDayNavProps>): React.JSX.Element {
  const index = dayKeys.indexOf(selectedDayKey);
  const heading = formatDayColumnHeading(selectedDayKey);
  const isToday = selectedDayKey === today;
  const [previous] = index > 0 ? [dayKeys[index - 1]] : [undefined];
  const [next] = index >= 0 && index < dayKeys.length - 1 ? [dayKeys[index + 1]] : [undefined];

  return (
    <div className="border-border flex items-center justify-between border-b px-2 py-2">
      {/* A4 — this is the PRIMARY mobile day-navigation control: `size="icon"` (36px) plus a
          transparent `after:-inset-1.5` ring takes the real tap target to 48px, with no change
          to the visual chevron's weight. */}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Previous day"
        className="relative after:absolute after:-inset-1.5 after:content-['']"
        disabled={previous === undefined}
        onClick={() => {
          if (previous !== undefined) onSelect(previous);
        }}
      >
        <ChevronLeft className="h-4 w-4" aria-hidden="true" />
      </Button>
      <span className={cn('text-sm font-semibold', isToday ? 'text-primary' : 'text-foreground')}>
        {heading.weekday} {heading.dayNumber}
        {isToday && ' · Today'}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Next day"
        className="relative after:absolute after:-inset-1.5 after:content-['']"
        disabled={next === undefined}
        onClick={() => {
          if (next !== undefined) onSelect(next);
        }}
      >
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
      </Button>
    </div>
  );
}

function formatHourLabel(hour: number): string {
  if (hour === 0) return '12 AM';
  if (hour === 12) return '12 PM';
  return hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
}

interface NowLineProps {
  readonly now: Date;
  readonly timezone: string;
  readonly gridRange: { start: number; end: number };
}

/** ⚠ MUST use `zonedMinutesOfDay` — NOT a hand-rolled `Intl.DateTimeFormat(... hour12: false)`
 *  reimplementation (that resolves to the `h24` cycle on several locale/ICU combinations, which
 *  emits `"24"` for midnight and makes the line vanish for the whole hour). One definition of
 *  "minutes of day in a zone", the same one the DST tests pin. */
function NowLine({ now, timezone, gridRange }: Readonly<NowLineProps>): React.JSX.Element | null {
  const minutes = zonedMinutesOfDay(now.toISOString(), timezone);
  if (minutes < gridRange.start || minutes > gridRange.end) return null;
  const top = (minutes - gridRange.start) * PX_PER_MINUTE;
  return (
    <span
      aria-hidden="true"
      className="bg-destructive pointer-events-none absolute right-0 left-0 z-20 h-0.5"
      style={{ top }}
    >
      <span className="bg-destructive absolute -top-1 -left-1 h-2 w-2 rounded-full" />
    </span>
  );
}
