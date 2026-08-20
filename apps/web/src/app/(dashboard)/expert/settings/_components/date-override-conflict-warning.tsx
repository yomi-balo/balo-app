'use client';

import { useEffect, useId, useRef } from 'react';
import { CalendarClock, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LocalDateTime } from '@/components/balo/date/local-date-time';
import type { AvailabilityConflictReportDto } from '../_types/availability-conflict';

interface DateOverrideConflictWarningProps {
  report: AvailabilityConflictReportDto;
  /** Human range label for the header, e.g. "25 Dec 2026 – 2 Jan 2027". */
  rangeLabel: string;
  pending: boolean;
  onConfirm: () => void;
  onBack: () => void;
}

/**
 * BAL-416 — the warning view of the "Add time off" popover, shown when the server reports
 * `conflictCount > 0`. Pure presentation: no fetching, no analytics (both live in the
 * popover, which owns the `pick` ↔ `conflicts` state machine).
 *
 * ⚠ THE ONLY RESOLUTION AFFORDANCE IS "block anyway" — this ticket cancels nothing. The
 * sessions listed below stand; blocking these dates only stops NEW bookings.
 *
 * ⚠ C2 — THIS VIEW SWAPS INTO AN ALREADY-OPEN POPOVER (the "pick" view is replaced in
 * place, it is not a fresh dialog open Radix would announce on its own), so without help a
 * screen-reader user gets no signal that their "Block these dates" click swapped the DOM out
 * from under them, and a keyboard user loses focus to `<body>` when that button leaves the
 * tree.
 *
 * ⚠ R2 — FOCUS LANDS ON THE HEADING, NOT ON "BLOCK DATES ANYWAY". A `<button>` fires its
 * click on Enter KEYDOWN, and OS key-repeat sends further keydowns to whatever now has focus
 * — so focusing the destructive confirm button meant a single held Enter (from clicking
 * "Block these dates" moments earlier) could dismiss this warning and commit the block with
 * no human having read a word of it. The `<h3>` is the safe landing spot, and is also the
 * ARIA APG guidance for an interstitial: never land focus on the destructive affordance.
 *
 * ⚠ R2 — `role="alertdialog"`, NOT `role="alert"`. This subtree contains FOCUSABLE controls
 * and receives focus (both on mount, and via the popover's own focus trap), nested inside
 * Radix's `role="dialog"`. `role="alert"` is `aria-live="assertive" aria-atomic="true"` and
 * is specified as content that neither receives focus nor contains interactive widgets — the
 * `schedule-dst-warning.tsx` precedent this originally copied is a STATIC non-interactive
 * box, so the two cases are not alike. `role="alertdialog"` is the correct composition for an
 * in-place interstitial that takes focus, and pairs naturally with `aria-labelledby` pointing
 * at the heading being focused.
 */
export function DateOverrideConflictWarning({
  report,
  rangeLabel,
  pending,
  onConfirm,
  onBack,
}: Readonly<DateOverrideConflictWarningProps>): React.JSX.Element {
  const heading =
    report.conflictCount === 1
      ? '1 session is already booked in these dates'
      : `${report.conflictCount} sessions are already booked in these dates`;
  const extraCount = report.conflictCount - report.conflicts.length;
  const headingId = useId();

  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <div role="alertdialog" aria-labelledby={headingId} className="space-y-3 p-3">
      <div className="flex items-start gap-3">
        <div className="bg-warning/10 border-warning/25 flex size-10 shrink-0 items-center justify-center rounded-lg border">
          <CalendarClock className="text-warning h-[18px] w-[18px]" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <h3
            ref={headingRef}
            id={headingId}
            tabIndex={-1}
            className="text-foreground text-sm font-semibold outline-none"
          >
            {heading}
          </h3>
          <p className="text-muted-foreground mt-1 text-sm leading-relaxed">
            Blocking these dates only stops new bookings — the sessions below still go ahead as
            planned.
          </p>
        </div>
      </div>

      <div className="text-muted-foreground text-xs font-medium">{rangeLabel}</div>

      <ul className="divide-border max-h-56 divide-y overflow-y-auto">
        {report.conflicts.map((conflict) => (
          <li key={conflict.consultationId} className="py-2 text-sm">
            <span className="text-foreground">
              <LocalDateTime
                iso={conflict.startAt}
                variant="day-month-time"
                timeZone={report.timezone}
              />
            </span>
            {conflict.clientCompanyName !== null && (
              <span className="text-muted-foreground"> · {conflict.clientCompanyName}</span>
            )}
          </li>
        ))}
        {report.truncated && extraCount > 0 && (
          <li className="text-muted-foreground py-2 text-sm">+ {extraCount} more sessions</li>
        )}
      </ul>

      <p className="text-muted-foreground text-xs">Times shown in {report.timezone}.</p>

      <div className="space-y-2">
        <Button onClick={onConfirm} disabled={pending} className="h-11 w-full focus-visible:ring-2">
          {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
          Block dates anyway
        </Button>
        <Button
          variant="ghost"
          onClick={onBack}
          disabled={pending}
          className="h-11 w-full focus-visible:ring-2"
        >
          Choose other dates
        </Button>
      </div>
    </div>
  );
}
