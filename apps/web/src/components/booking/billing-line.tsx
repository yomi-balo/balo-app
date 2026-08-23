import { Receipt } from 'lucide-react';
import { MIN_MEETING_MINUTES } from '@balo/shared/meetings';

/**
 * BAL-400 (D4c) — the ONLY billing copy in the whole flow. No rate is rendered anywhere —
 * not here, not in the header, not on confirm, not in the booked state. The minimum is
 * INTERPOLATED from `MIN_MEETING_MINUTES`, never hardcoded (D1b).
 */
export function BillingLine(): React.JSX.Element {
  return (
    <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
      <Receipt className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      Charged only for time used · {MIN_MEETING_MINUTES}-minute minimum applies.
    </p>
  );
}

/** Footer cancellation line, verbatim per D4/plan Copy Reference — no countdown, no fee schedule. */
export function CancellationLine(): React.JSX.Element {
  return (
    <p className="text-muted-foreground text-center text-xs">Free until scheduled start time.</p>
  );
}
