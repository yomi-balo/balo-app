'use client';

import { useEffect, useState } from 'react';
import { startOfMonth } from 'date-fns';
import type { DayButton } from 'react-day-picker';
import { Calendar, CalendarDayButton } from '@/components/ui/calendar';
import { cn } from '@/lib/utils';
import { calendarDateToDayKey, dayKeyToCalendarDate } from './availability-day-keys';

interface AvailabilityMonthCalendarProps {
  selectedDayKey: string | null;
  onSelectDayKey: (dayKey: string) => void;
  /** Day keys (viewer-zone) with at least one time at the chosen length — the dot. */
  daysAtLength: ReadonlySet<string>;
  /** Day keys that only have shorter times — the hollow ring. Empty while the length is pinned. */
  daysShorterOnly: ReadonlySet<string>;
  /** The chosen length, for the legend. */
  lengthMinutes: number;
  /**
   * ⚠ DAY KEYS, NOT INSTANTS — both bounds must be derived in the SAME frame as
   * `daysAtLength`. `startOfMonth(someInstant)` reads BROWSER-local getters, while the keys in
   * those sets are computed in the VIEWER's zone. The settings preview passes the expert's
   * saved timezone by design, so the two frames genuinely differ: an expert whose zone is
   * `Australia/Melbourne` opening Settings from London near a month boundary could see August
   * days carrying dots while forward navigation stopped at July.
   */
  /** Viewer-zone today — bounds the calendar from navigating before the current month. */
  viewerTodayKey: string;
  /** Viewer-zone far edge of the served window — bounds forward navigation (the prototype has
   *  none; navigating past the served window would show a permanently empty month). */
  viewerWindowEndKey: string;
}

function AvailabilityDayButton(
  props: Readonly<React.ComponentProps<typeof DayButton>>
): React.JSX.Element {
  const { modifiers } = props;
  const showDot = Boolean(modifiers.atLength) && !modifiers.selected;
  const shorterOnly = Boolean(modifiers.shorterOnly);
  return (
    <CalendarDayButton
      {...props}
      // The picker's own label wins over visible text, so the ring's meaning is appended to it.
      aria-label={
        shorterOnly ? `${props['aria-label'] ?? ''}, shorter times only` : props['aria-label']
      }
      // Keep the 44px touch target even though the cell width is tightened at md+.
      className={cn(props.className, 'relative pointer-coarse:aspect-auto pointer-coarse:h-11')}
    >
      {props.day.date.getDate()}
      {showDot && (
        <span
          aria-hidden="true"
          className="bg-primary absolute bottom-[5px] h-1.5 w-1.5 rounded-full"
        />
      )}
      {shorterOnly && !modifiers.selected && (
        <span
          aria-hidden="true"
          className="border-muted-foreground absolute bottom-[5px] h-1.5 w-1.5 rounded-full border-[1.5px]"
        />
      )}
    </CalendarDayButton>
  );
}

export function AvailabilityMonthCalendar({
  selectedDayKey,
  onSelectDayKey,
  daysAtLength,
  daysShorterOnly,
  lengthMinutes,
  viewerTodayKey,
  viewerWindowEndKey,
}: Readonly<AvailabilityMonthCalendarProps>): React.JSX.Element {
  const atLength = (date: Date): boolean => daysAtLength.has(calendarDateToDayKey(date));
  const shorterOnly = (date: Date): boolean => daysShorterOnly.has(calendarDateToDayKey(date));

  // Controlled so a jump to a day in another month (restore, "Go to …") moves the view with it.
  const [month, setMonth] = useState(() =>
    startOfMonth(dayKeyToCalendarDate(selectedDayKey ?? viewerTodayKey))
  );
  useEffect(() => {
    if (selectedDayKey) setMonth(startOfMonth(dayKeyToCalendarDate(selectedDayKey)));
  }, [selectedDayKey]);

  return (
    <div>
      <Calendar
        mode="single"
        weekStartsOn={1}
        selected={selectedDayKey ? dayKeyToCalendarDate(selectedDayKey) : undefined}
        onSelect={(date) => {
          if (date) onSelectDayKey(calendarDateToDayKey(date));
        }}
        startMonth={startOfMonth(dayKeyToCalendarDate(viewerTodayKey))}
        endMonth={startOfMonth(dayKeyToCalendarDate(viewerWindowEndKey))}
        month={month}
        onMonthChange={setMonth}
        disabled={(date) => !atLength(date) && !shorterOnly(date)}
        modifiers={{ atLength, shorterOnly }}
        components={{ DayButton: AvailabilityDayButton }}
        // Fit at the 640px dialog: left cell is 640 - 2 (border) - 48 (step p-6) - 340 - 1 = 249px;
        // with its md p-4 (32) the month gets 217px, so 7 cells at 28px (196) + gaps fit where the
        // default p-3 + 7 x 32px (248) did not.
        className="w-full p-0 md:[--cell-size:--spacing(7)]"
      />
      <div className="border-border mt-4 flex items-center gap-2 border-t pt-3.5">
        <span aria-hidden="true" className="bg-primary h-1.5 w-1.5 rounded-full" />
        <span className="text-muted-foreground text-[10px]">{lengthMinutes}-minute times</span>
        {daysShorterOnly.size > 0 && (
          <>
            <span
              aria-hidden="true"
              className="border-muted-foreground ml-2 h-1.5 w-1.5 rounded-full border-[1.5px]"
            />
            <span className="text-muted-foreground text-[10px]">Shorter times only</span>
          </>
        )}
      </div>
    </div>
  );
}
