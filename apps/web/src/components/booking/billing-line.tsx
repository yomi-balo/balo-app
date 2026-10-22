import { Receipt } from 'lucide-react';
import { MIN_MEETING_MINUTES } from '@balo/shared/meetings';

/**
 * BAL-400 (D4c) — billing copy for the flow. No rate is rendered anywhere — not here, not in the
 * header, not on confirm, not in the booked state. The minimum is INTERPOLATED from
 * `MIN_MEETING_MINUTES`, never hardcoded (D1b). BAL-614 amends D4c: `LengthNote` is a second
 * piece of billing copy, shown under the picker's length control; it still names no rate.
 */
export function BillingLine(): React.JSX.Element {
  return (
    <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
      <Receipt className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      Charged only for time used · {MIN_MEETING_MINUTES}-minute minimum applies.
    </p>
  );
}

const LENGTH_NOTE_COPY = {
  per_minute: `You pay for the minutes you use, not the length you pick. ${MIN_MEETING_MINUTES}-minute minimum.`,
  project: 'Project calls are free at any length.',
} as const;

/** BAL-614 — what the picked length means for billing, under the picker's length control. */
export function LengthNote({
  billing,
}: Readonly<{ billing: 'per_minute' | 'project' }>): React.JSX.Element {
  return (
    <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
      <Receipt className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {LENGTH_NOTE_COPY[billing]}
    </p>
  );
}

/**
 * BAL-474 (R6-C4, owner-approved) — the footer cancellation line: no countdown, no fee schedule. It used to
 * read "Free until scheduled start time.", which is false once anyone joins early: cancelling needs the
 * meeting to be `scheduled`, and the first presence flips it. Cancelling is accepted exactly while nobody has
 * joined, and nothing is ever charged for a call nobody joined.
 */
export const CANCELLATION_LINE_COPY = 'Free to cancel until anyone joins the call.';

export function CancellationLine(): React.JSX.Element {
  return <p className="text-muted-foreground text-center text-xs">{CANCELLATION_LINE_COPY}</p>;
}
