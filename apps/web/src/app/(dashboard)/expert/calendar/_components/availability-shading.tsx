'use client';

import { useEffect } from 'react';
import { formatInTimeZone } from 'date-fns-tz';
import {
  useExpertAvailability,
  type AvailabilityView,
} from '@/components/availability/use-expert-availability';
import {
  zonedMinutesOfDay,
  zonedDayKey,
  zonedMeetingSpan,
  formatDayColumnHeading,
} from '@/lib/calendar/zoned-grid';
import { PX_PER_MINUTE, GUTTER_WIDTH_PX } from '@/lib/calendar/grid-geometry';

interface AvailabilityShadingProps {
  readonly expertProfileId: string;
  /** Already clamped to `1..14` by the caller — see `shadingRequestDays` in `calendar-shell.tsx`. */
  readonly days: number;
  readonly scheduleTimezone: string;
  readonly dayKeys: readonly string[];
  readonly gridRange: { start: number; end: number };
  /**
   * Today's day key IN `scheduleTimezone`. Days BEFORE it were never queried — the endpoint's
   * window starts at now — so their sr-only summary must say so rather than assert an absence
   * of availability (D3 / fix round 3, R2). Optional so the pure-rendering tests can omit it.
   */
  readonly todayDayKey?: string;
  /**
   * The LAST day key the availability request actually covered (`today + days - 1`). Days after
   * it were never queried either — same rule, other end.
   */
  readonly coverageEndDayKey?: string;
  /** Lifts the raw hook view up so the parent can render the shared inline notes OUTSIDE the
   *  grid overlay (header/switcher/week-nav must stay operable during a shading-only error). */
  readonly onViewChange?: (view: AvailabilityView) => void;
  /** Lifts the hook's `reload` up so the parent's error/unavailable notes can offer a real
   *  "Try again" (balo-ui `layouts-states.md`: "Always include a retry action"). Stable — the
   *  hook memoises it with no dependencies — so a plain effect will not re-fire. */
  readonly onReloadChange?: (reload: () => void) => void;
}

interface MinuteRun {
  start: number;
  end: number;
}

/** Merge overlapping/adjacent [start, end) minute ranges into contiguous runs so the wash reads
 *  as a band rather than a series of hairline-separated rects. */
function mergeRuns(ranges: readonly MinuteRun[]): MinuteRun[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: MinuteRun[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/**
 * ⚠ BRANCHES ON THE DAY, NOT ON `runs.length` (BAL-498 fix round 3, R2). "No availability set" is
 * a POSITIVE CLAIM — it may only be made about a day the endpoint was actually asked about. A
 * partially-beyond-horizon week (weekStart = today+10 → `days: 14`) renders days 14-16, and the
 * past days of the current week are never in the window either; announcing absence-of-data as
 * absence-of-availability for those is exactly what D3 forbids, and the shell's beyond-horizon
 * note only ever covered the FULLY-beyond week.
 */
function formatDaySummary(
  runs: readonly MinuteRun[],
  dayKey: string,
  todayDayKey: string | undefined,
  coverageEndDayKey: string | undefined
): string {
  // Day keys are `yyyy-MM-dd`, zero-padded — lexicographic comparison IS calendar comparison.
  if (todayDayKey !== undefined && dayKey < todayDayKey) return 'Past';
  if (coverageEndDayKey !== undefined && dayKey > coverageEndDayKey) {
    return 'Beyond the availability window';
  }
  if (runs.length === 0) return 'No availability set';
  const parts = runs.map(
    (run) => `${formatMinuteOfDay(run.start)} to ${formatMinuteOfDay(run.end)}`
  );
  return `Available ${parts.join(' and ')}`;
}

/**
 * `'9:00 AM'` from a minute-of-day (already IN the schedule timezone — `zonedMinutesOfDay`
 * produced it). ⚠ THIS IS THE FIX FOR THE B4 REGRESSION: the previous implementation rebuilt a
 * UTC instant from the minute value and re-projected it through `formatZonedTime(iso, timezone)`
 * — a SECOND zone conversion of an already-zoned quantity, which shifted the label by the full
 * UTC offset (a Sydney expert's "9:00 AM–5:00 PM" wash read as "7:00 PM to 3:00 AM" to a
 * screen-reader user). Formatting the wall-clock hour/minute directly, anchored at UTC midnight
 * and rendered back out in UTC, performs NO zone conversion at all — the number that goes in is
 * the number that comes out.
 */
function formatMinuteOfDay(minutes: number): string {
  const hours = Math.floor(minutes / 60) % 24;
  const mins = minutes % 60;
  return formatInTimeZone(new Date(Date.UTC(1970, 0, 1, hours, mins)), 'UTC', 'h:mm a');
}

/**
 * BAL-498 (D3) — the shading overlay. Owns `useExpertAvailability`; mounted by the caller ONLY
 * when the visible week is inside the 14-day horizon (a hook cannot be called conditionally, a
 * component can be rendered conditionally). Semantics: the endpoint returns a BOOKABLE-SLOT
 * grid with vendor-busy time and booked consultations already subtracted — "what clients can
 * still book," with the expert's own meeting blocks drawn on top. Renders NOTHING (`null`) for
 * every state but `ready`; the caller renders the purpose-built inline note for the rest via
 * `onViewChange`.
 */
export function AvailabilityShading({
  expertProfileId,
  days,
  scheduleTimezone,
  dayKeys,
  gridRange,
  todayDayKey,
  coverageEndDayKey,
  onViewChange,
  onReloadChange,
}: Readonly<AvailabilityShadingProps>): React.JSX.Element | null {
  const { view, reload } = useExpertAvailability(expertProfileId, days);

  useEffect(() => {
    onViewChange?.(view);
  }, [view, onViewChange]);

  useEffect(() => {
    onReloadChange?.(reload);
  }, [reload, onReloadChange]);

  if (view.kind !== 'ready') {
    return null;
  }

  const columnWidthPercent = 100 / dayKeys.length;
  const runsByDay = new Map<string, MinuteRun[]>();
  for (const dayKey of dayKeys) {
    runsByDay.set(dayKey, []);
  }
  const pushRun = (dayKey: string, run: MinuteRun): void => {
    if (run.end <= run.start) return;
    runsByDay.get(dayKey)?.push(run);
  };
  for (const slot of view.slots) {
    // ⚠ CROSS-MIDNIGHT SLOTS ARE FRAGMENTED, exactly like meetings (BAL-498 fix round 3, R3).
    // `availability/resolver.ts` supports `crossesMidnight` (`endTime < startTime`), so a
    // 22:00→02:00 rule is reachable; the previous `end - start` arithmetic then produced a
    // NEGATIVE height, an invalid CSS value, and a band that silently did not paint at all.
    // Reuses `zonedMeetingSpan` — the meeting side's own fragment helper — rather than inventing
    // a second definition of "clipped at local midnight".
    const startDayKey = zonedDayKey(slot.start, scheduleTimezone);
    const span = zonedMeetingSpan(slot.start, slot.end, scheduleTimezone);
    pushRun(startDayKey, { start: span.startMinutes, end: span.endMinutes });
    if (span.crossesMidnight) {
      pushRun(zonedDayKey(slot.end, scheduleTimezone), {
        start: 0,
        end: zonedMinutesOfDay(slot.end, scheduleTimezone),
      });
    }
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-0">
      <div aria-hidden="true">
        {dayKeys.map((dayKey, dayIndex) => {
          const runs = mergeRuns(runsByDay.get(dayKey) ?? []);
          return (
            <div key={dayKey}>
              {runs.map((run) => (
                <span
                  key={`${run.start}-${run.end}`}
                  className="bg-primary/8 dark:bg-primary/15 absolute"
                  style={{
                    left: `calc(${GUTTER_WIDTH_PX}px + (100% - ${GUTTER_WIDTH_PX}px) * ${dayIndex} / ${dayKeys.length})`,
                    width: `calc((100% - ${GUTTER_WIDTH_PX}px) * ${columnWidthPercent} / 100)`,
                    top: (run.start - gridRange.start) * PX_PER_MINUTE,
                    height: (run.end - run.start) * PX_PER_MINUTE,
                  }}
                />
              ))}
            </div>
          );
        })}
      </div>
      {/* NOT aria-hidden — the wash rects convey nothing without this text equivalent. Each
          summary carries the `id` that `week-grid.tsx`'s matching day column header points its
          `aria-describedby` at (WIRED as of fix round 3, A2 — these ids were dead attributes
          before, so all seven summaries were announced as one disconnected block instead of
          each being attached to the day it describes). The weekday prefix stays: it is what
          keeps the block readable if a user reaches the summaries directly. */}
      <span className="sr-only">
        {dayKeys.map((dayKey) => {
          const { weekday } = formatDayColumnHeading(dayKey);
          return (
            <span key={dayKey} id={`calendar-availability-summary-${dayKey}`}>
              {weekday}:{' '}
              {formatDaySummary(
                mergeRuns(runsByDay.get(dayKey) ?? []),
                dayKey,
                todayDayKey,
                coverageEndDayKey
              )}
            </span>
          );
        })}
      </span>
    </div>
  );
}
