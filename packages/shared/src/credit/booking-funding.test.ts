import { describe, expect, it } from 'vitest';
import {
  assessCardRemovalCoverage,
  assessCaseBookingFunding,
  estimateCaseBookingMinor,
  type BookingFundingSnapshot,
  type CardRemovalSnapshot,
  type ReservableCaseBooking,
} from './booking-funding';
import type { HoldStatus } from './receivable-coverage';

/**
 * BAL-474 (plan §I.3 / §I.7) — the booking funding verdict's gate order, row by row. The check-time
 * sequential property is pinned by `packages/db/src/invariants/a-no-mandate-booking-is-accepted-
 * only-within-its-credit-at-check-time.test.ts` (F10); the hold-before-mandate order by F8.
 */

const MINUTE_MS = 60_000;
/** Client 700 / minute at the default fee. */
const RATE_700 = 33_600;
const WALLET = 'wallet-1';

function window(startOffsetMinutes: number, minutes: number): { start: Date; end: Date } {
  const base = Math.ceil(Date.now() / MINUTE_MS) * MINUTE_MS;
  const start = new Date(base + startOffsetMinutes * MINUTE_MS);
  return { start, end: new Date(start.getTime() + minutes * MINUTE_MS) };
}

const BOOKING = (() => {
  const { start, end } = window(240, 30);
  return { scheduledStart: start, scheduledEnd: end };
})();

function reservable(
  expertRateCents: number | null,
  startOffsetMinutes: number,
  minutes: number
): ReservableCaseBooking {
  const { start, end } = window(startOffsetMinutes, minutes);
  return {
    meetingId: `meeting-${startOffsetMinutes}`,
    scheduledStart: start,
    scheduledEnd: end,
    expertProfileId: 'expert-a',
    expertRateCents,
  };
}

function noMandate(
  availableMinor: number,
  rows: readonly ReservableCaseBooking[] = [],
  expertRateCents: number | null = RATE_700
): BookingFundingSnapshot {
  return {
    kind: 'no_mandate',
    walletId: WALLET,
    expertRateCents,
    availableMinor,
    reservable: rows,
  };
}

const HOLD: HoldStatus = {
  onHold: true,
  openReceivableCount: 2,
  confirmationWasRequested: true,
  balanceMinor: -24_000,
  promoGrantedSinceDebtMinor: 0,
  amountToClearMinor: 24_000,
};

describe('estimateCaseBookingMinor', () => {
  it('prices a window with the SAME estimator admission uses: 30 min at 700 / min = 21,000', () => {
    const { start, end } = window(60, 30);
    expect(estimateCaseBookingMinor(RATE_700, start, end)).toBe(21_000);
  });

  it('clamps an absurd window exactly as the admission hold is clamped (MAX_SESSION_MINUTES)', () => {
    const { start, end } = window(60, 10_000);
    expect(estimateCaseBookingMinor(RATE_700, start, end)).toBe(240 * 700);
  });
});

describe('assessCaseBookingFunding — the gate order (§I.3)', () => {
  it('1. no wallet ⇒ no_wallet', () => {
    expect(assessCaseBookingFunding({ kind: 'no_wallet' }, BOOKING)).toEqual({
      ok: false,
      reason: 'no_wallet',
    });
  });

  it('2. an open receivable with a figure ⇒ account_on_hold, carrying the hold', () => {
    expect(
      assessCaseBookingFunding({ kind: 'on_hold', walletId: WALLET, hold: HOLD }, BOOKING)
    ).toEqual({ ok: false, reason: 'account_on_hold', hold: HOLD });
  });

  it('2. an open receivable the balance already covers ⇒ covered_hold (heal, then re-run)', () => {
    expect(
      assessCaseBookingFunding(
        {
          kind: 'on_hold',
          walletId: WALLET,
          hold: { ...HOLD, balanceMinor: 0, amountToClearMinor: 0 },
        },
        BOOKING
      )
    ).toEqual({ ok: false, reason: 'covered_hold', walletId: WALLET });
  });

  it('3. an active mandate ⇒ ok (mandate) — the reservation never refuses a mandate company', () => {
    expect(assessCaseBookingFunding({ kind: 'mandate', walletId: WALLET }, BOOKING)).toEqual({
      ok: true,
      arm: 'mandate',
    });
  });

  it('4. an unknown expert ⇒ unknown_expert (fail closed)', () => {
    expect(assessCaseBookingFunding({ kind: 'unknown_expert', walletId: WALLET }, BOOKING)).toEqual(
      {
        ok: false,
        reason: 'unknown_expert',
      }
    );
  });

  it('4. a rate-less expert ⇒ ok (rate_missing) — the expert’s gap, never the client’s refusal', () => {
    expect(assessCaseBookingFunding(noMandate(0, [], null), BOOKING)).toEqual({
      ok: true,
      arm: 'rate_missing',
    });
  });

  it('5. available < estimate ⇒ no_mandate_insufficient_balance (BAL-478’s panel), even with reservations', () => {
    expect(
      assessCaseBookingFunding(noMandate(20_999, [reservable(RATE_700, 60, 30)]), BOOKING)
    ).toEqual({
      ok: false,
      reason: 'no_mandate_insufficient_balance',
      estimateMinor: 21_000,
      availableMinor: 20_999,
    });
  });

  it('6. available − reserved < estimate ⇒ reserved_by_upcoming, with the exact top-up', () => {
    expect(
      assessCaseBookingFunding(noMandate(30_000, [reservable(RATE_700, 60, 30)]), BOOKING)
    ).toEqual({
      ok: false,
      reason: 'reserved_by_upcoming',
      estimateMinor: 21_000,
      availableMinor: 30_000,
      reservedMinor: 21_000,
      reservedBookingCount: 1,
      topUpNeededMinor: 12_000,
    });
  });

  it('6. a rate-less reserved booking reserves nothing and is not counted', () => {
    // Alone, a rate-less booking leaves the whole 30,000 available for this 21,000 one.
    expect(
      assessCaseBookingFunding(noMandate(30_000, [reservable(null, 60, 30)]), BOOKING)
    ).toEqual({ ok: true, arm: 'balance' });
    expect(
      assessCaseBookingFunding(
        noMandate(30_000, [reservable(null, 60, 30), reservable(RATE_700, 120, 30)]),
        BOOKING
      )
    ).toMatchObject({
      reason: 'reserved_by_upcoming',
      reservedBookingCount: 1,
      reservedMinor: 21_000,
    });
  });

  it('6. boundary: available − reserved === estimate is accepted', () => {
    expect(
      assessCaseBookingFunding(noMandate(42_000, [reservable(RATE_700, 60, 30)]), BOOKING)
    ).toEqual({
      ok: true,
      arm: 'balance',
    });
  });

  it('7. enough for this and every upcoming booking ⇒ ok (balance)', () => {
    expect(
      assessCaseBookingFunding(noMandate(100_000, [reservable(RATE_700, 60, 30)]), BOOKING)
    ).toEqual({
      ok: true,
      arm: 'balance',
    });
  });
});

/**
 * BAL-474 owner ruling D10.6 — `assessCardRemovalCoverage`: the booking verdict's own reservation
 * arithmetic, run for a wallet that HAS a mandate as if the card were already gone.
 */
describe('assessCardRemovalCoverage — may the card be removed? (D10.6)', () => {
  function mandate(
    availableMinor: number,
    rows: readonly ReservableCaseBooking[] = []
  ): CardRemovalSnapshot {
    return { kind: 'mandate', walletId: WALLET, availableMinor, reservable: rows };
  }

  // One 30-minute booking at 700 / minute reserves 21,000.
  const ONE_BOOKING = [reservable(RATE_700, 60, 30)];

  it('boundary: available === reserved is ok (a top-up of exactly the figure lets the card go)', () => {
    expect(assessCardRemovalCoverage(mandate(21_000, ONE_BOOKING))).toEqual({ ok: true });
  });

  it('boundary: one minor unit short refuses, carrying every figure', () => {
    expect(assessCardRemovalCoverage(mandate(20_999, ONE_BOOKING))).toEqual({
      ok: false,
      reason: 'upcoming_bookings_uncovered',
      availableMinor: 20_999,
      reservedMinor: 21_000,
      reservedBookingCount: 1,
      topUpNeededMinor: 1,
    });
  });

  it('the top-up figure is reserved − available, over EVERY upcoming booking', () => {
    const verdict = assessCardRemovalCoverage(
      mandate(10_000, [reservable(RATE_700, 60, 30), reservable(RATE_700, 120, 15)])
    );
    // 21,000 + 10,500 reserved against 10,000 available.
    expect(verdict).toMatchObject({
      ok: false,
      reservedMinor: 31_500,
      reservedBookingCount: 2,
      topUpNeededMinor: 21_500,
    });
  });

  it('a top-up of exactly the figure clears the refusal (the "or more" copy is literally true)', () => {
    const rows = [reservable(RATE_700, 60, 30), reservable(RATE_700, 120, 15)];
    const refused = assessCardRemovalCoverage(mandate(10_000, rows));
    if (refused.ok) throw new Error('expected a refusal');
    expect(assessCardRemovalCoverage(mandate(10_000 + refused.topUpNeededMinor, rows))).toEqual({
      ok: true,
    });
  });

  it('zero upcoming bookings is ok, however low the balance', () => {
    expect(assessCardRemovalCoverage(mandate(0))).toEqual({ ok: true });
    expect(assessCardRemovalCoverage(mandate(-5_000))).toEqual({ ok: true });
  });

  it('a rate-less upcoming booking reserves nothing and is not counted', () => {
    expect(assessCardRemovalCoverage(mandate(0, [reservable(null, 60, 30)]))).toEqual({ ok: true });
    expect(
      assessCardRemovalCoverage(
        mandate(0, [reservable(null, 60, 30), reservable(RATE_700, 90, 30)])
      )
    ).toMatchObject({ ok: false, reservedBookingCount: 1, reservedMinor: 21_000 });
  });

  it('no active mandate ⇒ ok: nothing was exempted, so there is nothing to protect', () => {
    expect(assessCardRemovalCoverage({ kind: 'no_mandate', walletId: WALLET })).toEqual({
      ok: true,
    });
    expect(assessCardRemovalCoverage({ kind: 'no_wallet' })).toEqual({ ok: true });
  });

  it('the figure passes through unchanged above the single top-up maximum (the wording is a UI concern)', () => {
    // 240 min at 700 / min = 168,000 per booking; 7 of them = 1,176,000 > A$10,000 (1,000,000).
    const rows = Array.from({ length: 7 }, (_, i) => reservable(RATE_700, 60 + i * 300, 240));
    expect(assessCardRemovalCoverage(mandate(0, rows))).toMatchObject({
      ok: false,
      reservedBookingCount: 7,
      topUpNeededMinor: 1_176_000,
    });
  });

  it("prices upcoming bookings with the booking verdict's own estimator — the two verdicts agree", () => {
    // The booking verdict on a NO-mandate snapshot with the same numbers refuses with the same
    // reserved figure and count, so the two surfaces can never disagree about the reservation.
    const rows = [reservable(RATE_700, 60, 30), reservable(RATE_700, 120, 15)];
    const booking = assessCaseBookingFunding(noMandate(30_000, rows), BOOKING);
    const removal = assessCardRemovalCoverage(mandate(30_000, rows));
    if (booking.ok || booking.reason !== 'reserved_by_upcoming')
      throw new Error('expected reserved');
    if (removal.ok) throw new Error('expected a refusal');
    expect(removal.reservedMinor).toBe(booking.reservedMinor);
    expect(removal.reservedBookingCount).toBe(booking.reservedBookingCount);
  });
});
