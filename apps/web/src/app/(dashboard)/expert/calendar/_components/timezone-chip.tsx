'use client';

import { useEffect, useState } from 'react';
import { Clock, Info } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { formatTimezoneLabel } from '@/lib/calendar/zoned-grid';

interface TimezoneChipProps {
  readonly scheduleTimezone: string;
}

const DIFFERS_EXPLANATION =
  "Your device is set to a different timezone. This calendar always shows your schedule's timezone — the same one your availability hours are set in.";

/**
 * BAL-498 — the persistent timezone chip. The `Info` affordance (Tooltip on hover/focus, tap-
 * `Popover` on touch — never hover-only) appears ONLY when the browser zone differs from the
 * schedule zone. The comparison runs in an effect (browser-zone read), so it never perturbs SSR
 * hydration of the chip label itself, which is built entirely from `scheduleTimezone`.
 */
export function TimezoneChip({ scheduleTimezone }: Readonly<TimezoneChipProps>): React.JSX.Element {
  const [browserDiffers, setBrowserDiffers] = useState(false);

  useEffect(() => {
    const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    setBrowserDiffers(browserZone !== scheduleTimezone);
  }, [scheduleTimezone]);

  const label = formatTimezoneLabel(scheduleTimezone);

  return (
    <div className="text-muted-foreground flex items-center gap-1.5 text-sm">
      <Clock className="h-3.5 w-3.5" aria-hidden="true" />
      <span id="calendar-timezone-label">{label}</span>
      {browserDiffers && (
        <>
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-describedby="calendar-timezone-explanation"
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded focus-visible:ring-2 focus-visible:outline-none"
              >
                <Info className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="sr-only">Why does this differ from my device?</span>
              </button>
            </PopoverTrigger>
            <PopoverContent className="text-sm">{DIFFERS_EXPLANATION}</PopoverContent>
          </Popover>
          <span id="calendar-timezone-explanation" className="sr-only">
            {DIFFERS_EXPLANATION}
          </span>
        </>
      )}
    </div>
  );
}
