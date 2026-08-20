'use client';

import { Check, Globe } from 'lucide-react';
import { extractCityFromTimezone } from '@balo/shared/timezone';
import { summarizeWeek, type WeekState } from '../_lib/schedule-helpers';

interface ScheduleSavedSummaryProps {
  week: WeekState;
  timezone: string;
}

/**
 * Read-only text summary of the saved schedule — a POST-SAVE CONFIRMATION of the AUTHORED
 * week, gated on `showSavedSummary`. The `ExpertAvailabilityCalendar` preview (BAL-236, always
 * on in `schedule-tab.tsx`'s `ready` branch) answers a different question: resolved BOOKABLE
 * slots after busy subtraction. This component is not superseded by it — they coexist.
 */
export function ScheduleSavedSummary({
  week,
  timezone,
}: Readonly<ScheduleSavedSummaryProps>): React.JSX.Element {
  const segments = summarizeWeek(week);
  const city = extractCityFromTimezone(timezone) ?? timezone;

  return (
    <div className="border-success/30 bg-success/10 rounded-xl border p-4">
      <div className="text-success mb-2 flex items-center gap-1.5 text-sm font-semibold">
        <Check className="h-4 w-4" aria-hidden="true" />
        Your bookable hours
      </div>

      {segments.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {segments.map((segment) => (
            <li key={`${segment.days}-${segment.hours}`} className="text-foreground text-sm">
              <span className="font-medium">{segment.days}</span>
              <span className="text-muted-foreground">, {segment.hours}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-sm">No days are currently open for booking.</p>
      )}

      <p className="text-muted-foreground mt-3 flex items-center gap-1.5 text-xs">
        <Globe className="h-3.5 w-3.5" aria-hidden="true" />
        Times shown in {city} ({timezone}). Clients see slots converted to their own timezone.
      </p>
      <p className="text-muted-foreground/80 mt-1 text-xs">
        A visual slot preview will appear here once the availability calendar ships.
      </p>
    </div>
  );
}
