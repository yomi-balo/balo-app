'use client';

import { AlertCircle, AlertTriangle, LogIn, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** The overridable half of {@link HardFailurePanelProps} — what a caller can restate. */
export interface HardFailurePanelCopy {
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

export interface HardFailurePanelProps extends HardFailurePanelCopy {
  onRetry: () => void;
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

/**
 * Session expired — the viewer's credential died, not a refusal of the booking.
 *
 * ⚠ No "Try again": retrying re-sends the same dead token, so signing in is the only move that
 * changes the outcome.
 *
 * `caseTitle` is set only when the credential died mid-submit, after the case row was written —
 * on the pre-flight path nothing was written, and the copy must not claim otherwise.
 */
export function SessionExpiredPanel({
  caseTitle,
  onSignIn,
  onClose,
}: Readonly<{
  caseTitle: string | null;
  onSignIn: () => void;
  onClose: () => void;
}>): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-4 px-6 py-10 text-center">
      <span className="bg-muted flex h-14 w-14 items-center justify-center rounded-xl p-4">
        <LogIn className="text-muted-foreground h-6 w-6" aria-hidden="true" />
      </span>
      <div className="max-w-[360px] space-y-1.5">
        <h2 className="text-foreground text-lg font-semibold">Sign in to finish booking</h2>
        <p className="text-muted-foreground text-sm leading-relaxed">
          {caseTitle === null
            ? 'Your session timed out, so nothing was booked — and nothing was saved. Sign in and your time is still there to pick.'
            : `Your session timed out before we could lock in the time. “${caseTitle}” is saved — sign in and pick up right where you left off.`}
        </p>
      </div>
      {/* `min-h-11` — the booking surface's own touch target, which `size="sm"` does not meet.
          These two are the only way out of a dead session, so they are the last controls that
          should be hard to hit on a phone. */}
      <div className="flex flex-col items-center gap-2">
        <Button className="min-h-11" onClick={onSignIn}>
          Sign in
        </Button>
        <Button variant="ghost" size="sm" className="min-h-11" onClick={onClose}>
          I&apos;ll finish this later
        </Button>
      </div>
    </div>
  );
}

/**
 * BAL-478 (R6) — the funding pre-condition's panel. ONE condition, TWO audiences, branched on the
 * ACTOR'S CAPABILITY (resolved server-side via `hasCapability`, ADR-1029 — never a role string,
 * and never `activeMode`).
 *
 * ⚠ NO DEAD-END CTA ON THE MEMBER ARM. Booking needs CONSUME_CREDITS; adding a card needs
 * MANAGE_BILLING, so `/settings/billing` would refuse the ordinary booker. The member arm's
 * promise ("your billing admins have been told") is kept by `enforceBookingFunding`, which
 * publishes `booking.funding_blocked` before it returns — do not weaken that copy to a maybe.
 *
 * ⚠ NO MONEY FIGURE, EITHER ARM. No balance, no shortfall, no rate — BAL-400 D4c ("the ONLY
 * billing copy in the whole flow"; no rate is rendered anywhere) and fee concealment both hold.
 *
 * ⚠ NOT DESTRUCTIVE-TONED. This is a setup step, not a failure: `bg-info/10` + `Wallet`, never
 * the `AlertCircle`/`destructive` treatment `HardFailurePanel` uses.
 *
 * Copy is an UNCLEARED MJ checkpoint (R6) — workable placeholders, gender-neutral, no figure,
 * framed as a solvable setup step. See the BAL-478 plan §6.3 / PR description.
 */
export function FundingSetupPanel({
  canManageBilling,
  onManageBilling,
  onClose,
}: Readonly<{
  canManageBilling: boolean;
  onManageBilling: () => void;
  onClose: () => void;
}>): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-4 px-6 py-10 text-center">
      <span className="bg-info/10 flex h-14 w-14 items-center justify-center rounded-xl p-4">
        <Wallet className="text-info h-6 w-6" aria-hidden="true" />
      </span>
      <div className="max-w-[360px] space-y-1.5">
        <h2 className="text-foreground text-lg font-semibold">One setup step first</h2>
        <p className="text-muted-foreground text-sm leading-relaxed">
          {canManageBilling
            ? 'Before a consultation can be booked, your team needs a payment method on file — or enough credit to cover it. Set that up and pick your time straight after.'
            : "Before a consultation can be booked, your team needs a payment method on file — or enough credit to cover it. Your billing admins have been notified — come back and pick a time once it's set up."}
        </p>
      </div>
      {canManageBilling ? (
        <div className="flex flex-col items-center gap-2">
          <Button className="min-h-11" onClick={onManageBilling}>
            Set up billing
          </Button>
          <Button variant="ghost" size="sm" className="min-h-11" onClick={onClose}>
            I&apos;ll do this later
          </Button>
        </div>
      ) : (
        <Button className="min-h-11" onClick={onClose}>
          Got it
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
