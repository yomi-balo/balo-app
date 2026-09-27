import { estimatedMinutesForWindow } from './estimate-window';
import type { HoldStatus } from './receivable-coverage';
import { deriveSessionEstimate } from './session-estimate';

/**
 * BAL-474 (ADR-1040 Amendment 7 §H; owner rulings D6.1 + D6.5) — THE ONE VERDICT on whether a
 * company may BOOK a new Case consultation, over ONE snapshot of its funding
 * (`bookingFundingRepository.readSnapshot`). The web booking gate (advisory, UX + fan-out) and
 * the `POST /meetings` guard (defence in depth) both call this, so the two can never disagree.
 *
 * GATE ORDER (plan §I.3) — the D6.1 hold arm, then BAL-478's arms, then the D6.5 reservation:
 *
 *   1. no wallet                                  → `no_wallet`
 *   2. an open receivable (the soft account hold) → `account_on_hold` when the top-up figure is
 *      > 0; `covered_hold` when it is 0 (the API guard heals it and re-runs; the web gate
 *      defers). BEFORE the mandate on purpose: a mandate holder whose settlements keep declining
 *      is exactly the population the brake exists for.
 *   3. an active mandate                          → ok (`mandate`) — the card funds anything
 *      above the credit, so D6.5 never refuses a mandate company.
 *   4. unknown expert                             → `unknown_expert` (fail closed);
 *      a rate-less expert                         → ok (`rate_missing`) — BAL-478 §4.3: that is
 *      the expert's gap, never the client's refusal.
 *   5. balance (BAL-478)                          → `available < estimate` ⇒
 *      `no_mandate_insufficient_balance` (BAL-478's approved panel).
 *   6. reservation (D6.5)                         → `available − Σ upcoming < estimate` ⇒
 *      `reserved_by_upcoming`. Arm 6 runs only once arm 5 passed: `reserved ≥ 0` makes arm 5's
 *      failure imply arm 6's, so the split exists purely so a refusal that would happen anyway
 *      keeps BAL-478's panel and the D6.5 panel appears only when planned consultations are the
 *      reason. Combined, the predicate is exactly D6.5's `available − reserved ≥ estimate`.
 *   7.                                            → ok (`balance`).
 *
 * ⚠ A CHECK-TIME GUARANTEE, NOT A HOLD. Every booking this ACCEPTS satisfied the inequality at
 * its own check time. Simultaneous submits, reschedules, overruns and the populations the
 * snapshot does not reserve (a sessionless `in_progress` meeting; an ended, unsettled
 * sessionless meeting) can all push a company's upcoming bookings past its credit; a shortfall
 * is then billed session-scoped into a receivable, which brakes the next booking (§I.5).
 *
 * PURE — no I/O, no clock. The snapshot carries every figure; the booking carries its window.
 */

/**
 * One upcoming, not-yet-started, sessionless Case booking of the company — what the D6.5 soft
 * reservation sums. `expertRateCents` is the expert's CURRENT rate (the same column admission
 * prices from), so a rate change since booking is reflected on the next check (§I.4).
 */
export interface ReservableCaseBooking {
  readonly meetingId: string;
  readonly scheduledStart: Date;
  readonly scheduledEnd: Date;
  readonly expertProfileId: string;
  readonly expertRateCents: number | null;
}

/** ONE consistent read of a company's booking funding (see `bookingFundingRepository`). */
export type BookingFundingSnapshot =
  | { readonly kind: 'no_wallet' }
  | { readonly kind: 'on_hold'; readonly walletId: string; readonly hold: HoldStatus }
  /** An active mandate and no hold — the reads below it are short-circuited. */
  | { readonly kind: 'mandate'; readonly walletId: string }
  | { readonly kind: 'unknown_expert'; readonly walletId: string }
  | {
      readonly kind: 'no_mandate';
      readonly walletId: string;
      /** The BOOKED expert's current rate; `null` ⇒ no rate set. */
      readonly expertRateCents: number | null;
      /** `balance − Σ active holds net of their posted consumption` (§I.2, D8.5). */
      readonly availableMinor: number;
      readonly reservable: readonly ReservableCaseBooking[];
    };

export type CaseBookingFundingVerdict =
  | { readonly ok: true; readonly arm: 'mandate' | 'rate_missing' | 'balance' }
  | { readonly ok: false; readonly reason: 'no_wallet' | 'unknown_expert' }
  /** An open receivable with a top-up figure > 0. */
  | { readonly ok: false; readonly reason: 'account_on_hold'; readonly hold: HoldStatus }
  /** An open receivable the balance already covers (figure 0) — heal it, then re-run (D8.1). */
  | { readonly ok: false; readonly reason: 'covered_hold'; readonly walletId: string }
  | {
      readonly ok: false;
      readonly reason: 'no_mandate_insufficient_balance';
      readonly estimateMinor: number;
      readonly availableMinor: number;
    }
  | {
      readonly ok: false;
      readonly reason: 'reserved_by_upcoming';
      readonly estimateMinor: number;
      readonly availableMinor: number;
      readonly reservedMinor: number;
      /** Reservable bookings with a POSITIVE estimate — a rate-less one reserves nothing. */
      readonly reservedBookingCount: number;
      /** `estimate + reserved − available` — > 0 by construction. */
      readonly topUpNeededMinor: number;
    };

/**
 * ONE estimate per booking — the SAME two functions that size admission's hold
 * (`estimatedMinutesForWindow` + `deriveSessionEstimate`), at the default Balo fee.
 */
export function estimateCaseBookingMinor(
  rateCents: number,
  scheduledStart: Date,
  scheduledEnd: Date
): number {
  return deriveSessionEstimate({
    expertHourlyMinor: rateCents,
    estimatedMinutes: estimatedMinutesForWindow(scheduledStart, scheduledEnd),
  }).estimateMinor;
}

/**
 * The D6.5 reservation over a snapshot's upcoming bookings: Σ of each booking's estimate, and how
 * many of them reserve anything. A rate-less booking, or one whose estimate is not positive,
 * reserves nothing and is not counted. The ONE summation — the booking verdict and the
 * card-removal verdict both call it, so the two can never price the same bookings differently.
 */
function sumReservedBookings(reservable: readonly ReservableCaseBooking[]): {
  readonly reservedMinor: number;
  readonly reservedBookingCount: number;
} {
  let reservedMinor = 0;
  let reservedBookingCount = 0;
  for (const reserved of reservable) {
    if (reserved.expertRateCents === null) continue;
    const reservedEstimate = estimateCaseBookingMinor(
      reserved.expertRateCents,
      reserved.scheduledStart,
      reserved.scheduledEnd
    );
    if (reservedEstimate <= 0) continue;
    reservedMinor += reservedEstimate;
    reservedBookingCount += 1;
  }
  return { reservedMinor, reservedBookingCount };
}

export function assessCaseBookingFunding(
  snapshot: BookingFundingSnapshot,
  booking: { readonly scheduledStart: Date; readonly scheduledEnd: Date }
): CaseBookingFundingVerdict {
  // 1. No wallet.
  if (snapshot.kind === 'no_wallet') {
    return { ok: false, reason: 'no_wallet' };
  }
  // 2. The hold (D6.1) — before the mandate, deliberately.
  if (snapshot.kind === 'on_hold') {
    return snapshot.hold.amountToClearMinor > 0
      ? { ok: false, reason: 'account_on_hold', hold: snapshot.hold }
      : { ok: false, reason: 'covered_hold', walletId: snapshot.walletId };
  }
  // 3. An active mandate funds anything above the credit (D6.5).
  if (snapshot.kind === 'mandate') {
    return { ok: true, arm: 'mandate' };
  }
  // 4. The expert.
  if (snapshot.kind === 'unknown_expert') {
    return { ok: false, reason: 'unknown_expert' };
  }
  if (snapshot.expertRateCents === null) {
    return { ok: true, arm: 'rate_missing' };
  }
  // 5. Balance (BAL-478).
  const estimateMinor = estimateCaseBookingMinor(
    snapshot.expertRateCents,
    booking.scheduledStart,
    booking.scheduledEnd
  );
  const { availableMinor } = snapshot;
  if (availableMinor < estimateMinor) {
    return { ok: false, reason: 'no_mandate_insufficient_balance', estimateMinor, availableMinor };
  }
  // 6. The soft reservation (D6.5).
  const { reservedMinor, reservedBookingCount } = sumReservedBookings(snapshot.reservable);
  if (availableMinor - reservedMinor < estimateMinor) {
    return {
      ok: false,
      reason: 'reserved_by_upcoming',
      estimateMinor,
      availableMinor,
      reservedMinor,
      reservedBookingCount,
      topUpNeededMinor: estimateMinor + reservedMinor - availableMinor,
    };
  }
  // 7.
  return { ok: true, arm: 'balance' };
}

/**
 * BAL-474 (ADR-1040 Amendment 7 §H; owner ruling D10.6) — ONE consistent read of what a card
 * removal is checked against (`bookingFundingRepository.readCardRemovalSnapshot`).
 *
 * WHY IT IS NOT {@link BookingFundingSnapshot}. That snapshot deliberately stops at an active
 * mandate (`kind: 'mandate'` carries no figures — the card funds anything above the credit, so
 * nothing below it is read). Removing the card is exactly the act that takes the card away, so
 * the same figures — the NETTED available balance and the upcoming reservable bookings — are read
 * here for a wallet that HAS a mandate. Same executor, same isolation, same finder.
 */
export type CardRemovalSnapshot =
  | { readonly kind: 'no_wallet' }
  /** No active mandate: nothing exempted the wallet from the booking checks, so nothing to protect. */
  | { readonly kind: 'no_mandate'; readonly walletId: string }
  | {
      readonly kind: 'mandate';
      readonly walletId: string;
      /** `balance − Σ active holds net of their posted consumption` — the booking figure (D8.5). */
      readonly availableMinor: number;
      readonly reservable: readonly ReservableCaseBooking[];
    };

export type CardRemovalCoverageVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'upcoming_bookings_uncovered';
      readonly availableMinor: number;
      readonly reservedMinor: number;
      /** Upcoming bookings with a POSITIVE estimate — a rate-less one reserves nothing. */
      readonly reservedBookingCount: number;
      /** `reserved − available` — > 0 by construction. */
      readonly topUpNeededMinor: number;
    };

/**
 * May the card be removed? Evaluates the wallet's snapshot AS IF THE CARD WERE ALREADY GONE: with
 * no mandate, D6.5 says a company's upcoming Case bookings must be covered by its credit
 * (`available − Σ upcoming estimates ≥ 0`). A company that booked those consultations BECAUSE the
 * card exempted it from the balance arm and the reservation must not be able to pull the card and
 * leave them running uncovered.
 *
 *   · no wallet, or no active mandate → ok (nothing was exempted, nothing to protect);
 *   · an active mandate and no upcoming booking that reserves anything → ok: with nothing booked
 *     there is no exposure for the card to be backing (a negative balance is an open receivable,
 *     which `detachSavedCard` refuses on before it ever gets here);
 *   · otherwise `available − reserved < 0` → `upcoming_bookings_uncovered`, with
 *     `topUpNeededMinor = reserved − available`: a top-up of that or more makes the predicate
 *     `available − reserved ≥ 0`, exactly the boundary the booking verdict uses.
 *
 * The estimator is {@link assessCaseBookingFunding}'s own ({@link sumReservedBookings}), never a
 * second one. PURE — no I/O, no clock.
 */
export function assessCardRemovalCoverage(
  snapshot: CardRemovalSnapshot
): CardRemovalCoverageVerdict {
  if (snapshot.kind !== 'mandate') {
    return { ok: true };
  }
  const { reservedMinor, reservedBookingCount } = sumReservedBookings(snapshot.reservable);
  const { availableMinor } = snapshot;
  if (reservedBookingCount === 0 || availableMinor >= reservedMinor) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: 'upcoming_bookings_uncovered',
    availableMinor,
    reservedMinor,
    reservedBookingCount,
    topUpNeededMinor: reservedMinor - availableMinor,
  };
}
