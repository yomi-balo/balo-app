'use client';

import { AlertTriangle } from 'lucide-react';
import type { SpringForwardGap } from '@balo/shared/timezone';
import { extractCityFromTimezone } from '@balo/shared/timezone';
import { DAY_META, formatGapMinutes, type DstGapMatch } from '../_lib/schedule-helpers';

interface ScheduleDstWarningProps {
  gap: SpringForwardGap;
  timezone: string;
  /** Which interval landed in the gap — selects the attribution copy. */
  match: DstGapMatch;
}

function formatGapDate(dateISO: string): string {
  // dateISO is a local calendar date — read it as UTC so the label doesn't shift.
  const date = new Date(`${dateISO}T00:00:00Z`);
  return date.toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/**
 * Non-blocking heads-up shown when an enabled range lands in the timezone's upcoming
 * daylight-saving spring-forward gap (that wall-clock hour does not exist that day).
 */
export function ScheduleDstWarning({
  gap,
  timezone,
  match,
}: Readonly<ScheduleDstWarningProps>): React.JSX.Element {
  const city = extractCityFromTimezone(timezone) ?? timezone;
  const sourceMeta = DAY_META[match.sourceDayIndex];
  const gapDayMeta = DAY_META[(match.sourceDayIndex + 1) % DAY_META.length];

  return (
    <div
      role="alert"
      className="border-warning/40 bg-warning/10 flex items-start gap-2.5 rounded-xl border p-4"
    >
      <AlertTriangle className="text-warning mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="text-sm leading-relaxed">
        <p className="text-foreground font-medium">Daylight saving affects one of your hours</p>
        {match.isOvernightTail && sourceMeta && gapDayMeta ? (
          <p className="text-muted-foreground mt-0.5">
            On {formatGapDate(gap.dateISO)}, clocks in {city} skip from{' '}
            {formatGapMinutes(gap.gapStartMinutes)} to {formatGapMinutes(gap.gapEndMinutes)}. The{' '}
            {sourceMeta.full}–{gapDayMeta.full} overnight range you set (which continues into the
            early hours of {gapDayMeta.full}) falls in this window, so it won&apos;t exist that once
            — no need to change anything, we just won&apos;t offer bookings in the skipped hour.
          </p>
        ) : (
          <p className="text-muted-foreground mt-0.5">
            On {formatGapDate(gap.dateISO)}, clocks in {city} skip from{' '}
            {formatGapMinutes(gap.gapStartMinutes)} to {formatGapMinutes(gap.gapEndMinutes)}. A
            range you&apos;ve set that day falls in this window, so it won&apos;t exist that once —
            no need to change anything, we just won&apos;t offer bookings in the skipped hour.
          </p>
        )}
      </div>
    </div>
  );
}
