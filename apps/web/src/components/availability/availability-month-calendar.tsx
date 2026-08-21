'use client';

import { startOfMonth } from 'date-fns';
import type { DayButton } from 'react-day-picker';
import { Calendar, CalendarDayButton } from '@/components/ui/calendar';
import { cn } from '@/lib/utils';
import { calendarDateToDayKey, dayKeyToCalendarDate } from './availability-day-keys';

interface AvailabilityMonthCalendarProps {
  selectedDayKey: string | null;
  onSelectDayKey: (dayKey: string) => void;
  /** Which day keys (viewer-zone) have at least one slot. */
  daysWithSlots: ReadonlySet<string>;
  /**
   * ⚠ DAY KEYS, NOT INSTANTS — both bounds must be derived in the SAME frame as
   * `daysWithSlots`. `startOfMonth(someInstant)` reads BROWSER-local getters, while the keys in
   * `daysWithSlots` are computed in the VIEWER's zone. The settings preview passes the expert's
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
  const showDot = Boolean(modifiers.hasSlots) && !modifiers.selected;
  return (
    <CalendarDayButton {...props} className={cn(props.className, 'relative')}>
      {props.day.date.getDate()}
      {showDot && (
        <span
          aria-hidden="true"
          className="bg-primary absolute bottom-1 h-[3px] w-[3px] rounded-full"
        />
      )}
    </CalendarDayButton>
  );
}

export function AvailabilityMonthCalendar({
  selectedDayKey,
  onSelectDayKey,
  daysWithSlots,
  viewerTodayKey,
  viewerWindowEndKey,
}: Readonly<AvailabilityMonthCalendarProps>): React.JSX.Element {
  const hasSlots = (date: Date): boolean => daysWithSlots.has(calendarDateToDayKey(date));

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
        disabled={(date) => !hasSlots(date)}
        modifiers={{ hasSlots }}
        components={{ DayButton: AvailabilityDayButton }}
        className="w-full"
      />
      <div className="border-border mt-4 flex items-center gap-2 border-t pt-3.5">
        <span aria-hidden="true" className="bg-primary h-[3px] w-[3px] rounded-full" />
        <span className="text-muted-foreground text-[10px]">Available</span>
      </div>
    </div>
  );
}
