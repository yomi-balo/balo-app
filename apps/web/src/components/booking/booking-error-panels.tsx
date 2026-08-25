'use client';

import { AlertCircle, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface HardFailurePanelProps {
  onRetry: () => void;
  /** Defaults to the BAL-400 case-booking headline. */
  title?: string;
  /**
   * BAL-283 (round-1 W8) — overridable because the default body says "Nothing was charged",
   * which is MONEY FRAMING on a free intro call (Ruling 2) AND a non-sequitur there: nothing
   * could have been charged, so reassuring the user about it invents a concern. The design
   * assumed this panel carried no money copy; it did.
   */
  body?: string;
  /**
   * BAL-283 (round-1 W9) — suppress the retry affordance for a failure that retrying CANNOT
   * fix (`not_permitted`). Offering "Try again" there is a dead end that fails identically.
   */
  hideRetry?: boolean;
}

/** Hard failure — nothing created yet. Standard destructive treatment. */
export function HardFailurePanel({
  onRetry,
  title = 'Something went wrong',
  body = "We couldn't start your booking. Nothing was charged.",
  hideRetry = false,
}: Readonly<HardFailurePanelProps>): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-4 px-6 py-12 text-center">
      <span className="bg-destructive/10 flex h-14 w-14 items-center justify-center rounded-xl">
        <AlertCircle className="text-destructive h-6 w-6" aria-hidden="true" />
      </span>
      <div className="max-w-[320px] space-y-1.5">
        <h2 className="text-foreground text-lg font-semibold">{title}</h2>
        <p className="text-muted-foreground text-sm leading-relaxed">{body}</p>
      </div>
      {hideRetry ? null : (
        <Button variant="outline" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

/** Partial failure — case created, meeting/provisioning failed. Warning-toned. */
export function PartialFailurePanel({
  caseTitle,
  onRetry,
  onChooseDifferentTime,
  onFinishLater,
}: Readonly<{
  caseTitle: string;
  onRetry: () => void;
  onChooseDifferentTime: () => void;
  onFinishLater: () => void;
}>): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-4 px-6 py-10 text-center">
      <span className="bg-warning/10 flex h-14 w-14 items-center justify-center rounded-xl p-4">
        <AlertTriangle className="text-warning h-6 w-6" aria-hidden="true" />
      </span>
      <div className="max-w-[360px] space-y-1.5">
        <h2 className="text-foreground text-lg font-semibold">
          Your case is saved — we just couldn&apos;t lock in the time
        </h2>
        <p className="text-muted-foreground text-sm leading-relaxed">
          &ldquo;{caseTitle}&rdquo; is ready. Try booking this slot again, or pick a different time.
        </p>
      </div>
      <div className="flex flex-col items-center gap-2">
        <Button onClick={onRetry}>Try again</Button>
        <Button variant="outline" size="sm" onClick={onChooseDifferentTime}>
          Choose a different time
        </Button>
        <Button variant="ghost" size="sm" onClick={onFinishLater}>
          I&apos;ll finish this later
        </Button>
      </div>
    </div>
  );
}

/** Stale slot at submit — inline, not full-panel; everything else in the form is preserved. */
export function StaleSlotBanner({
  onChooseNewTime,
}: Readonly<{ onChooseNewTime: () => void }>): React.JSX.Element {
  return (
    <div
      role="alert"
      className="bg-warning/10 border-warning/20 flex items-center justify-between gap-3 rounded-lg border p-3"
    >
      <div className="flex items-center gap-2">
        <AlertTriangle className="text-warning h-4 w-4 shrink-0" aria-hidden="true" />
        <p className="text-foreground text-xs font-medium">
          This time was just booked by someone else.
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={onChooseNewTime}>
        Choose a new time
      </Button>
    </div>
  );
}
