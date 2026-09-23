'use client';

import { useEffect, useState } from 'react';
import { Globe } from 'lucide-react';
import { ScheduleTimezoneCombobox } from './schedule-timezone-combobox';
import { formatWallClock, timezoneLabel } from '../_lib/timezone-label';

const MINUTE_MS = 60_000;

/**
 * The current instant, first set after mount — the server render and the first client
 * render both see `null`, so the clock can never cause a hydration mismatch — then
 * refreshed on every minute boundary.
 */
function useMinuteClock(): Date | null {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = (): void => {
      const current = new Date();
      setNow(current);
      timer = setTimeout(tick, MINUTE_MS - (current.getTime() % MINUTE_MS));
    };
    tick();
    return () => clearTimeout(timer);
  }, []);
  return now;
}

interface ScheduleTimezoneLineProps {
  /** The zone the weekly hours are authored in. */
  timezone: string;
  onChange: (tz: string) => void;
  disabled?: boolean;
}

/** "Hours are set in {zone} — currently {Ddd h:mm AM}" with a "Change timezone" link. */
export function ScheduleTimezoneLine({
  timezone,
  onChange,
  disabled,
}: Readonly<ScheduleTimezoneLineProps>): React.JSX.Element {
  const now = useMinuteClock();
  const clock = now ? formatWallClock(timezone, now) : '';

  return (
    <div className="flex flex-wrap items-center gap-x-2.5">
      <Globe className="text-muted-foreground size-[15px] shrink-0" aria-hidden="true" />
      <p className="text-muted-foreground text-[13px] leading-normal">
        Hours are set in{' '}
        <span className="text-foreground font-medium">
          {timezoneLabel(timezone, now ?? undefined)}
        </span>
        {clock && (
          <>
            {' '}
            — currently <span className="tabular-nums">{clock}</span>
          </>
        )}
      </p>
      <ScheduleTimezoneCombobox value={timezone} onChange={onChange} disabled={disabled} />
    </div>
  );
}
