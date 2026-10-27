import { describe, expect, it } from 'vitest';
import {
  assessCardRemovalCoverage,
  assessCaseBookingFunding,
  estimateCaseBookingMinor,
  suggestCaseBookingTopUpMinor,
  type BookingFundingSnapshot,
  type BookingTopUpPricing,
  type CardRemovalSnapshot,
  type ReservableCaseBooking,
} from './booking-funding';
import type { HoldStatus } from './receivable-coverage';
import { TOP_UP_LIMITS_MINOR } from './top-up-limits';

/**
 * BAL-474 (plan §I.3 / §I.7) — the booking funding verdict's gate order, row by row. The check-time
 * sequential property is pinned by `packages/db/src/invariants/a-no-mandate-booking-is-accepted-
 * only-within-its-credit-at-check-time.test.ts` (F10); the hold-before-mandate order by F8.
 */

const MINUTE_MS = 60_000;
/** Client 700 / minute at the default fee. */
const RATE_700 = 560;
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

function pricing(overrides: Partial<BookingTopUpPricing> = {}): BookingTopUpPricing {
  return {
    expertRateCents: RATE_700,
    availableMinor: 0,
    reservable: [],
    mandateActive: false,
    ...overrides,
  };
}

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
    expect(
      assessCaseBookingFunding({ kind: 'no_wallet', topUpPricing: pricing() }, BOOKING)
    ).toEqual({
      ok: false,
      reason: 'no_wallet',
    });
  });

  it('2. an open receivable with a figure ⇒ account_on_hold, carrying the hold', () => {
    expect(
      assessCaseBookingFunding(
        { kind: 'on_hold', walletId: WALLET, hold: HOLD, topUpPricing: pricing() },
        BOOKING
      )
    ).toEqual({ ok: false, reason: 'account_on_hold', hold: HOLD });
  });

  it('2. an open receivable the balance already covers ⇒ covered_hold (heal, then re-run)', () => {
    expect(
      assessCaseBookingFunding(
        {
          kind: 'on_hold',
          walletId: WALLET,
          hold: { ...HOLD, balanceMinor: 0, amountToClearMinor: 0 },
          topUpPricing: pricing(),
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

describe('suggestCaseBookingTopUpMinor', () => {
  const { min, step } = TOP_UP_LIMITS_MINOR;
  // 30 minutes at 700 / minute estimates 21,000.
  const noWallet = (p: Partial<BookingTopUpPricing> = {}): BookingFundingSnapshot => ({
    kind: 'no_wallet',
    topUpPricing: pricing(p),
  });
  const onHold = (amountToClearMinor: number, p: Partial<BookingTopUpPricing> = {}) =>
    ({
      kind: 'on_hold',
      walletId: WALLET,
      hold: { ...HOLD, amountToClearMinor },
      topUpPricing: pricing(p),
    }) satisfies BookingFundingSnapshot;

  it('no_wallet: estimate + reserved, rounded up to the minimum', () => {
    expect(suggestCaseBookingTopUpMinor(noWallet(), BOOKING)).toBe(min);
  });

  it('no_wallet: a large estimate rounds up to the next step', () => {
    const { start, end } = window(240, 240);
    const booking = { scheduledStart: start, scheduledEnd: end };
    // 240 minutes at 700 / minute = 168,000 → A$1,700 in 10,000 steps.
    expect(suggestCaseBookingTopUpMinor(noWallet(), booking)).toBe(170_000);
  });

  it('no_wallet: reservations add to the figure', () => {
    const rows = [reservable(RATE_700, 60, 240), reservable(RATE_700, 400, 240)];
    expect(suggestCaseBookingTopUpMinor(noWallet({ reservable: rows }), BOOKING)).toBe(
      Math.ceil((21_000 + 2 * 168_000) / step) * step
    );
  });

  it('no_wallet: a rate-less expert has no booking part, so the minimum', () => {
    expect(suggestCaseBookingTopUpMinor(noWallet({ expertRateCents: null }), BOOKING)).toBe(min);
  });

  it('no_mandate: estimate + reserved − available, on the step', () => {
    const rows = [reservable(RATE_700, 60, 240)];
    // 21,000 + 168,000 − 50,000 = 139,000 → 140,000.
    expect(suggestCaseBookingTopUpMinor(noMandate(50_000, rows), BOOKING)).toBe(140_000);
  });

  it('no_mandate: exact multiples do not round up a further step', () => {
    const { start, end } = window(240, 60);
    const booking = { scheduledStart: start, scheduledEnd: end };
    // 60 minutes at 700 / minute = 42,000; 12,000 available → need 30,000 = min.
    expect(suggestCaseBookingTopUpMinor(noMandate(12_000), booking)).toBe(30_000);
    // 42,000 − 2,000 = 40,000, already a step multiple.
    expect(suggestCaseBookingTopUpMinor(noMandate(2_000), booking)).toBe(40_000);
  });

  it('on_hold without a mandate: the larger of the hold figure and the booking part', () => {
    const rows = [reservable(RATE_700, 60, 240)];
    // booking part 21,000 + 168,000 − (−24,000) = 213,000; the hold figure 24,000 is smaller.
    expect(
      suggestCaseBookingTopUpMinor(
        onHold(24_000, { availableMinor: -24_000, reservable: rows }),
        BOOKING
      )
    ).toBe(220_000);
    // A hold bigger than the booking part wins.
    expect(
      suggestCaseBookingTopUpMinor(onHold(500_000, { availableMinor: 400_000 }), BOOKING)
    ).toBe(500_000);
  });

  it('on_hold with an active mandate: only the hold figure matters', () => {
    expect(
      suggestCaseBookingTopUpMinor(
        onHold(450_000, { mandateActive: true, reservable: [reservable(RATE_700, 60, 240)] }),
        BOOKING
      )
    ).toBe(450_000);
    expect(suggestCaseBookingTopUpMinor(onHold(24_000, { mandateActive: true }), BOOKING)).toBe(
      min
    );
  });

  it('on_hold: a rate-less expert falls back to the hold figure', () => {
    expect(suggestCaseBookingTopUpMinor(onHold(310_000, { expertRateCents: null }), BOOKING)).toBe(
      310_000
    );
  });

  it('mandate and unknown_expert have no booking part', () => {
    expect(suggestCaseBookingTopUpMinor({ kind: 'mandate', walletId: WALLET }, BOOKING)).toBe(min);
    expect(
      suggestCaseBookingTopUpMinor({ kind: 'unknown_expert', walletId: WALLET }, BOOKING)
    ).toBe(min);
  });

  it('may exceed the single top-up maximum — the caller decides', () => {
    const { start, end } = window(240, 240);
    const booking = { scheduledStart: start, scheduledEnd: end };
    const rows = Array.from({ length: 8 }, (_, i) => reservable(RATE_700, 300 + i * 300, 240));
    expect(suggestCaseBookingTopUpMinor(noWallet({ reservable: rows }), booking)).toBeGreaterThan(
      TOP_UP_LIMITS_MINOR.max
    );
  });

  /**
   * Apply a top-up of `topUpMinor` to a refusal snapshot, as the webhook credit would. `mandate`
   * says what the top-up did to an active mandate: it `survives` (the saved card was charged, or a
   * new card re-armed it), or it is `lost` (a new card replaced the card it was captured against
   * and nothing re-armed it).
   */
  function applyTopUp(
    snapshot: BookingFundingSnapshot,
    topUpMinor: number,
    mandate: 'survives' | 'lost' = 'survives'
  ): BookingFundingSnapshot {
    if (snapshot.kind === 'no_wallet') {
      const { topUpPricing } = snapshot;
      return {
        kind: 'no_mandate',
        walletId: WALLET,
        expertRateCents: topUpPricing.expertRateCents,
        availableMinor: topUpMinor,
        reservable: topUpPricing.reservable,
      };
    }
    if (snapshot.kind === 'on_hold') {
      const { topUpPricing, hold } = snapshot;
      if (topUpMinor < hold.amountToClearMinor) return snapshot;
      const availableMinor = topUpPricing.availableMinor + topUpMinor;
      return topUpPricing.mandateActive && mandate === 'survives'
        ? { kind: 'mandate', walletId: snapshot.walletId }
        : {
            kind: 'no_mandate',
            walletId: snapshot.walletId,
            expertRateCents: topUpPricing.expertRateCents,
            availableMinor,
            reservable: topUpPricing.reservable,
          };
    }
    if (snapshot.kind === 'no_mandate') {
      return { ...snapshot, availableMinor: snapshot.availableMinor + topUpMinor };
    }
    return snapshot;
  }

  const durations = [15, 30, 45, 60, 120, 240];
  const planned = [[], [60], [60, 240], [30, 30, 30, 30]] as const;
  const availables = [-50_000, 0, 10_000, 55_000, 250_000];
  const holds = [20_000, 45_000, 300_000];

  function grid(): { label: string; snapshot: BookingFundingSnapshot; booking: typeof BOOKING }[] {
    const cases: { label: string; snapshot: BookingFundingSnapshot; booking: typeof BOOKING }[] =
      [];
    for (const minutes of durations) {
      const { start, end } = window(240, minutes);
      const booking = { scheduledStart: start, scheduledEnd: end };
      for (const plannedMinutes of planned) {
        const reservableRows = plannedMinutes.map((m, i) => reservable(RATE_700, 300 + i * 300, m));
        const label = `${minutes}m booking, planned ${JSON.stringify(plannedMinutes)}`;
        cases.push({
          label: `no_wallet ${label}`,
          snapshot: noWallet({ reservable: reservableRows }),
          booking,
        });
        for (const available of availables) {
          cases.push({
            label: `no_mandate avail ${available} ${label}`,
            snapshot: noMandate(available, reservableRows),
            booking,
          });
          for (const hold of holds) {
            for (const mandateActive of [false, true]) {
              cases.push({
                label: `on_hold ${hold} mandate=${mandateActive} avail ${available} ${label}`,
                snapshot: onHold(hold, {
                  availableMinor: available,
                  reservable: reservableRows,
                  mandateActive,
                }),
                booking,
              });
            }
          }
        }
      }
    }
    return cases;
  }

  it('grid property: the suggestion passes the verdict, and (above the minimum) one step less fails', () => {
    const failures: string[] = [];
    let aboveMinimum = 0;
    const cases = grid();
    for (const { label, snapshot, booking } of cases) {
      // A no_mandate snapshot only refuses once the balance is short; the others always refuse.
      const before = assessCaseBookingFunding(snapshot, booking);
      if (before.ok) continue;
      const suggested = suggestCaseBookingTopUpMinor(snapshot, booking);
      if (suggested % step !== 0 || suggested < min)
        failures.push(`${label}: off-grid ${suggested}`);
      const after = assessCaseBookingFunding(applyTopUp(snapshot, suggested), booking);
      if (!after.ok) failures.push(`${label}: still refused at ${suggested} (${after.reason})`);
      if (suggested > min) {
        aboveMinimum += 1;
        const short = assessCaseBookingFunding(applyTopUp(snapshot, suggested - step), booking);
        if (short.ok) failures.push(`${label}: already passes at ${suggested - step}`);
      }
    }
    expect(failures).toEqual([]);
    // Positive control — the grid exercises suggestions above the minimum, not only the floor.
    expect(aboveMinimum).toBeGreaterThan(20);
  });

  it('grid property: a hold suggestion that leans on the mandate is refused once the mandate is lost, as a balance refusal whose own suggestion then books', () => {
    const failures: string[] = [];
    let refusedWhenLost = 0;
    for (const { label, snapshot, booking } of grid()) {
      if (snapshot.kind !== 'on_hold' || !snapshot.topUpPricing.mandateActive) continue;
      if (assessCaseBookingFunding(snapshot, booking).ok) continue;
      const suggested = suggestCaseBookingTopUpMinor(snapshot, booking);
      const lost = applyTopUp(snapshot, suggested, 'lost');
      const verdict = assessCaseBookingFunding(lost, booking);
      if (verdict.ok) continue;
      refusedWhenLost += 1;
      // The hold is cleared either way: what is left is a balance refusal, never a second hold.
      if (
        verdict.reason !== 'no_mandate_insufficient_balance' &&
        verdict.reason !== 'reserved_by_upcoming'
      ) {
        failures.push(`${label}: refused as ${verdict.reason}`);
        continue;
      }
      // The re-read after that refusal suggests again, and that figure books.
      const again = suggestCaseBookingTopUpMinor(lost, booking);
      if (!assessCaseBookingFunding(applyTopUp(lost, again), booking).ok) {
        failures.push(`${label}: still refused after a second top-up of ${again}`);
      }
    }
    expect(failures).toEqual([]);
    // Positive control — losing the mandate does refuse bookings the hold figure alone was sized
    // for, which is why a new card on this arm must re-arm the mandate.
    expect(refusedWhenLost).toBeGreaterThan(20);
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
