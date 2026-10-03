'use client';

import Link from 'next/link';
import { AlertCircle, AlertTriangle, Loader2, LogIn, Pause, Search, Wallet } from 'lucide-react';
import { TOP_UP_LIMITS_MINOR } from '@balo/shared/credit';
import { Button } from '@/components/ui/button';
import {
  formatAud,
  formatAudShort,
  upcomingConsultationsLabel,
} from '@/lib/credit/display-constants';

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
 * The expert cannot take this booking (they paused new work, or the account is no longer live).
 * One panel for every reason, so it never says which. Not destructive-toned: nothing is wrong
 * with the client's request. No retry, since the answer cannot change by trying again.
 */
export function ExpertUnavailablePanel({
  expertFirstName,
  similarExpertsHref,
  onClose,
}: Readonly<{
  expertFirstName: string | null;
  similarExpertsHref?: string;
  onClose: () => void;
}>): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-4 px-6 py-12 text-center">
      <span className="bg-paused-hatch border-paused-border flex h-14 w-14 items-center justify-center rounded-xl border">
        <Pause className="text-muted-foreground h-6 w-6" aria-hidden="true" />
      </span>
      <div className="max-w-[320px] space-y-1.5">
        <h2 className="text-foreground text-lg font-semibold">
          {expertFirstName ?? 'This expert'} isn&apos;t taking on new work right now.
        </h2>
        <p className="text-muted-foreground text-sm leading-relaxed">
          We can introduce you to someone with similar experience.
        </p>
      </div>
      <div className="flex flex-col items-center gap-2">
        {similarExpertsHref !== undefined && (
          <Button asChild>
            <Link href={similarExpertsHref}>
              <Search className="h-4 w-4" aria-hidden="true" />
              Find a similar expert
            </Link>
          </Button>
        )}
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      </div>
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
 * promise ("your billing admins have been notified") is kept by `enforceBookingFunding`, which
 * publishes `booking.funding_blocked` before it returns — do not weaken that copy to a maybe.
 *
 * ⚠ NO MONEY FIGURE, EITHER ARM. No balance, no shortfall, no rate — BAL-400 D4c ("the ONLY
 * billing copy in the whole flow"; no rate is rendered anywhere) and fee concealment both hold.
 *
 * ⚠ NOT DESTRUCTIVE-TONED. This is a setup step, not a failure: `bg-info/10` + `Wallet`, never
 * the `AlertCircle`/`destructive` treatment `HardFailurePanel` uses.
 *
 * ⚠⚠ EVERY SENTENCE MUST STAY TRUE AT READ TIME (fix round 3). Neither arm promises a RESULT
 * ("pick your time straight after" / "goes straight through") — a top-up covers only what it
 * covers, a longer booking or a drained balance hits the gate again, and a card can be removed
 * between setup and the next attempt. Both arms describe the ACTION available ("you can try
 * booking again"), never a guaranteed outcome.
 *
 * Copy is an UNCLEARED MJ checkpoint (R6) — workable placeholders, gender-neutral, no figure,
 * framed as a solvable setup step. See the BAL-478 plan §6.3 / PR description.
 *
 * `caseSaved` is set only when the refusal came back from the MEETING hop (the API's pre-write
 * funding guard), after the case row was written — see {@link CaseSavedNote}.
 *
 * ⚠ THE OTHER TWO BALANCE REFUSALS — an open receivable (D6.1) and planned consultations
 * (D6.5) — are {@link BookingBalancePanel}, which DOES show a top-up figure. This panel's
 * "no figure" posture is unchanged.
 */
export function FundingSetupPanel({
  canManageBilling,
  onManageBilling,
  onClose,
  caseSaved = null,
}: Readonly<{
  canManageBilling: boolean;
  onManageBilling: () => void;
  onClose: () => void;
  caseSaved?: CaseSavedNote | null;
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
            ? 'Before a consultation can be booked, your team needs a payment method on file — or enough credit to cover it. Set that up, then you can try booking again.'
            : "Before a consultation can be booked, your team needs a payment method on file — or enough credit to cover it. Your billing admins have been notified — come back and try again once it's set up."}
        </p>
        <CaseSavedLine caseSaved={caseSaved} />
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

/**
 * BAL-474 (copy v2.1 §8) — "your case is saved", for a funding refusal that came back from the
 * MEETING hop: the case row was written at hop 1 (active, not closed), so it is in the client's
 * Cases. The next booking's case chooser lists open cases for the same company and expert —
 * including a case with no consultation yet — so the client can choose it there.
 *
 * ⚠ IT DOES NOT PROMISE A RESUME. Every panel exit closes the dialog and the next open starts
 * fresh, so nothing carries the case into the next booking by itself; the line says only what is
 * true. `expertLabel` is the PARTY label (agency, or the independent expert's own name).
 */
export interface CaseSavedNote {
  readonly caseTitle: string;
  readonly expertLabel: string;
}

/** The case-saved sentence — copy v2.1 §8, the title in straight double quotes as drafted. */
export function caseSavedCopy(caseSaved: CaseSavedNote): string {
  return `"${caseSaved.caseTitle}" is saved in your Cases — choose it when you book with ${caseSaved.expertLabel} again.`;
}

function CaseSavedLine({
  caseSaved,
}: Readonly<{ caseSaved: CaseSavedNote | null }>): React.JSX.Element | null {
  if (caseSaved === null) return null;
  return (
    <p className="text-muted-foreground text-sm leading-relaxed">{caseSavedCopy(caseSaved)}</p>
  );
}

/** One of the two variants of {@link BookingBalancePanel}. */
export type BalanceVariant = 'hold' | 'reserved';

type BalanceAudience = 'manager' | 'member';
type BalanceArm = 'figure' | 'large' | 'fallback';

/** The company, spelled for the two positions a sentence can name it in. */
interface CompanyLabels {
  /** At the start of a sentence: "Northwind's" / "Your team's". */
  readonly start: string;
  /** Anywhere else: "Northwind's" / "your team's". */
  readonly mid: string;
}

interface BalanceCopyContext {
  readonly company: CompanyLabels;
  /** `A$275.00`. Empty on the failed-heal fallback, whose strings never read it. */
  readonly amount: string;
  /** `A$10,000` — the largest single top-up. */
  readonly maxTopUp: string;
  /** "1 upcoming consultation" / "3 upcoming consultations". Empty on the hold variant. */
  readonly count: string;
}

type BalanceCopyFn = (context: BalanceCopyContext) => string;

/** The `figure` arm is the default; `large` and `fallback` exist only where the copy has them. */
type BalanceCopyArms = Readonly<{ figure: BalanceCopyFn }> &
  Readonly<Partial<Record<'large' | 'fallback', BalanceCopyFn>>>;

interface BalanceVariantCopy {
  readonly heading: BalanceCopyArms;
  readonly body: Readonly<Record<BalanceAudience, BalanceCopyArms>>;
}

/**
 * ⚠⚠ THE BOOKING BALANCE PANEL'S COPY — ONE TABLE, keyed by variant, arm and audience, rendered
 * data-driven (never two near-identical components). Every string is `copy-draft-bal-474.md`
 * v2.1 §1a/§1b, character for character (OWNER-APPROVED; a change needs the owner again).
 *
 * The three arms:
 *  - `figure`   — a top-up figure at or below the single-top-up maximum;
 *  - `large`    — the figure is above {@link TOP_UP_LIMITS_MINOR}`.max`, so it takes "top-ups
 *                 totalling" (one top-up cannot cover it);
 *  - `fallback` — the hold's failed-heal fallback: the balance already covers the hold, but the
 *                 booking API could not clear it. No figure, so nothing can ever render A$0.00.
 *
 * The reserved variant always has a figure, and its member body names none, so it carries no
 * `fallback` and only the manager body has a `large` arm.
 */
export const BALANCE_PANEL_COPY: Readonly<Record<BalanceVariant, BalanceVariantCopy>> = {
  hold: {
    heading: {
      figure: () => 'One thing to settle first',
      fallback: () => 'An earlier hold is still clearing',
    },
    body: {
      manager: {
        figure: (c) =>
          `${c.company.start} balance needs a top-up of ${c.amount} or more before new consultations can be booked. Consultations already booked aren't affected.`,
        large: (c) =>
          `${c.company.start} balance needs top-ups totalling ${c.amount} or more before new consultations can be booked — each top-up can be up to ${c.maxTopUp}. Consultations already booked aren't affected.`,
        fallback: (c) =>
          `An earlier hold is still on ${c.company.mid} account, although the balance already covers it. It lifts automatically within a day, or at once with any top-up. Consultations already booked aren't affected.`,
      },
      member: {
        figure: (c) =>
          `${c.company.start} balance needs a top-up of ${c.amount} or more before new consultations can be booked. Your billing admins have been notified. Consultations already booked aren't affected.`,
        large: (c) =>
          `${c.company.start} balance needs top-ups totalling ${c.amount} or more before new consultations can be booked. Your billing admins have been notified. Consultations already booked aren't affected.`,
        fallback: (c) =>
          `An earlier hold is still on ${c.company.mid} account, although the balance already covers it. It lifts automatically within a day, or at once with any top-up. Your billing admins have been notified.`,
      },
    },
  },
  reserved: {
    heading: {
      figure: (c) => `Part of ${c.company.mid} balance is set aside for planned consultations`,
    },
    body: {
      manager: {
        figure: (c) =>
          `Part of ${c.company.mid} balance is set aside for ${c.count}, so there isn't enough left to book this one. A top-up of ${c.amount} or more would make room for it. ${c.company.start} balance still shows in full — nothing has been taken for the planned consultations yet.`,
        large: (c) =>
          `Part of ${c.company.mid} balance is set aside for ${c.count}, so there isn't enough left to book this one. Top-ups totalling ${c.amount} or more would make room for it — each top-up can be up to ${c.maxTopUp}. ${c.company.start} balance still shows in full — nothing has been taken for the planned consultations yet.`,
      },
      member: {
        figure: (c) =>
          `Part of ${c.company.mid} balance is set aside for ${c.count}, so there isn't enough left to book this one. Your billing admins have been notified. ${c.company.start} balance still shows in full — nothing has been taken for the planned consultations yet.`,
      },
    },
  },
};

/**
 * Copy v2.1 §1c — the toast for a failed workspace switch behind "Switch to {Company} and top
 * up". Shown only when the switch action returned a failure; the panel stays open.
 */
export const BOOKING_SWITCH_FAILED_COPY = {
  named: (companyName: string): string => `We couldn't switch to ${companyName}. Please try again.`,
  unnamed: "We couldn't switch companies. Please try again.",
} as const;

export function bookingSwitchFailedCopy(companyName: string | null): string {
  return companyName === null
    ? BOOKING_SWITCH_FAILED_COPY.unnamed
    : BOOKING_SWITCH_FAILED_COPY.named(companyName);
}

function companyLabels(companyName: string | null): CompanyLabels {
  if (companyName === null) {
    return { start: "Your team's", mid: "your team's" };
  }
  return { start: `${companyName}'s`, mid: `${companyName}'s` };
}

function topUpButtonLabel(companyIsActive: boolean, companyName: string | null): string {
  if (companyIsActive) return 'Top up';
  if (companyName === null) return 'Switch company and top up';
  return `Switch to ${companyName} and top up`;
}

/** The arm's copy, or the `figure` default where the table has no dedicated string. */
function pickArm(arms: BalanceCopyArms, arm: BalanceArm): BalanceCopyFn {
  if (arm === 'figure') return arms.figure;
  return arms[arm] ?? arms.figure;
}

interface BookingBalancePanelCommonProps {
  readonly canManageBilling: boolean;
  /** `null` ⇒ the name read failed; the panel says "your team". */
  readonly companyName: string | null;
  /** True ⇒ the held company is already the active workspace, so Top-up needs no switch. */
  readonly companyIsActive: boolean;
  /**
   * The figure is above `TOP_UP_LIMITS_MINOR.max`, so one top-up cannot cover it and the copy
   * says "top-ups totalling". Computed by the parent from the same constant.
   */
  readonly amountExceedsSingleTopUp: boolean;
  readonly caseSaved: CaseSavedNote | null;
  /** True while the workspace switch behind Top-up is in flight. */
  readonly isSwitching: boolean;
  readonly onTopUp: () => void;
  readonly onClose: () => void;
}

export type BookingBalancePanelProps = BookingBalancePanelCommonProps &
  (
    | {
        readonly variant: 'hold';
        /** `null` ⇒ the failed-heal fallback (no figure; never A$0.00). */
        readonly topUpNeededMinor: number | null;
      }
    | {
        readonly variant: 'reserved';
        /** Always a figure > 0: the reservation refuses only when a top-up would make room. */
        readonly topUpNeededMinor: number;
        readonly reservedBookingCount: number;
      }
  );

function resolveBalanceArm(
  topUpNeededMinor: number | null,
  exceedsSingleTopUp: boolean
): BalanceArm {
  if (topUpNeededMinor === null) return 'fallback';
  return exceedsSingleTopUp ? 'large' : 'figure';
}

/**
 * BAL-474 (ADR-1040 Amendment 7 §H; owner rulings D6.1 + D6.5) — the booking balance panel: a
 * new Case booking was refused because the company's balance needs a top-up first, either
 * because an open receivable (its soft account hold) refuses new bookings (`hold`), or because
 * planned consultations set part of the credit aside (`reserved`, no-mandate companies only).
 *
 * Mirrors {@link FundingSetupPanel}: ONE condition, TWO audiences, branched on the ACTOR'S
 * CAPABILITY (`canManageBilling`, resolved server-side via `hasCapability`, ADR-1029). NOT
 * destructive-toned — `bg-info/10` + `Wallet`: a solvable step, never a failure.
 *
 * ⚠ IT SHOWS A MONEY FIGURE, departing from {@link FundingSetupPanel}'s "no figure" posture for
 * THESE arms only. The figure is a TOP-UP amount, not a debt ("needs a top-up of A$275.00 or
 * more"): the client's own balance at all-in rates, so fee concealment is intact, and members
 * already see the shared balance (ADR-1040 *Wallet authorization*). Owner-approved (copy v2.1
 * §11, checkpoint 1): plain members see it.
 *
 * ⚠ THE TOP-UP ACTION TARGETS THE HELD COMPANY. The top-up page tops up the ACTIVE workspace's
 * company, so when the refusing company is not the active one the primary button reads "Switch
 * to {Company} and top up" and the parent switches workspace first (`onTopUp`).
 *
 * ⚠ NO A$0.00, EVER. `topUpNeededMinor === null` renders the hold's failed-heal fallback body,
 * which reads no figure; the reserved variant is typed to always carry one.
 *
 * ⚠ NO PROMISED OUTCOME. Every string states a condition or an available action, never that a
 * top-up guarantees a booking (a colleague's booking can change the figure).
 */
export function BookingBalancePanel(props: Readonly<BookingBalancePanelProps>): React.JSX.Element {
  const { canManageBilling, companyName, companyIsActive, caseSaved, isSwitching } = props;
  const arm = resolveBalanceArm(props.topUpNeededMinor, props.amountExceedsSingleTopUp);
  const context: BalanceCopyContext = {
    company: companyLabels(companyName),
    amount: props.topUpNeededMinor === null ? '' : formatAud(props.topUpNeededMinor),
    maxTopUp: formatAudShort(TOP_UP_LIMITS_MINOR.max),
    count:
      props.variant === 'reserved' ? upcomingConsultationsLabel(props.reservedBookingCount) : '',
  };
  const copy = BALANCE_PANEL_COPY[props.variant];
  const audience: BalanceAudience = canManageBilling ? 'manager' : 'member';
  const heading = pickArm(copy.heading, arm)(context);
  const body = pickArm(copy.body[audience], arm)(context);

  return (
    <div className="flex flex-col items-center gap-4 px-6 py-10 text-center">
      <span className="bg-info/10 flex h-14 w-14 items-center justify-center rounded-xl p-4">
        <Wallet className="text-info h-6 w-6" aria-hidden="true" />
      </span>
      <div className="max-w-[360px] space-y-1.5">
        <h2 className="text-foreground text-lg font-semibold">{heading}</h2>
        <p className="text-muted-foreground text-sm leading-relaxed">{body}</p>
        <CaseSavedLine caseSaved={caseSaved} />
      </div>
      {canManageBilling ? (
        <div className="flex flex-col items-center gap-2">
          <Button
            className="min-h-11"
            onClick={props.onTopUp}
            disabled={isSwitching}
            aria-busy={isSwitching}
          >
            {isSwitching ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            {topUpButtonLabel(companyIsActive, companyName)}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="min-h-11"
            onClick={props.onClose}
            disabled={isSwitching}
          >
            I&apos;ll do this later
          </Button>
        </div>
      ) : (
        <Button className="min-h-11" onClick={props.onClose}>
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
