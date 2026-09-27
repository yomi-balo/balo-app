import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  assessCaseBookingFunding,
  estimateCaseBookingMinor,
  type BookingFundingSnapshot,
  type HoldStatus,
  type ReservableCaseBooking,
} from '@balo/shared/credit';

/**
 * ⚠⚠ INVARIANT — A NO-MANDATE CASE BOOKING IS ACCEPTED ONLY WHEN ITS CREDIT COVERS IT AT CHECK
 * TIME. ADR-1040 Amendment 7 §H (BAL-474, owner ruling D6.5; worded per V1-F5 / V3-F9 / D8.8).
 *
 * Owner, verbatim: "if booking 1 is estimated to cost 200, that is held even though it still
 * appears as credit balance. When booking 2 is attempted, client should see that you do not have
 * enough balance because of another planned meeting, top up." Built as a CHECK-TIME soft
 * reservation, not a ledger hold: for a company WITHOUT an active mandate,
 *
 *   available − Σ estimate(upcoming, not-yet-started, sessionless Case bookings) ≥ estimate(this)
 *
 * ⚠ WHAT THIS GUARANTEES, PRECISELY: every booking the check ACCEPTS satisfied that inequality at
 * its OWN check time. It does NOT guarantee a company's upcoming bookings never exceed its credit —
 * simultaneous submits, reschedules, overruns and the unreserved populations (a sessionless
 * `in_progress` meeting; an ended, unsettled sessionless meeting) can all break that (plan §I.5).
 * The sequential property below holds only for bookings checked one after another.
 *
 * Per ADR-1032 this was AUTHORED AND RUN RED before `assessCaseBookingFunding`,
 * `estimateCaseBookingMinor` and the snapshot existed.
 */

interface ScannedFile {
  displayPath: string;
  url: URL;
}

function file(displayPath: string, relativeToThisFile: string): ScannedFile {
  return { displayPath, url: new URL(relativeToThisFile, import.meta.url) };
}

function scan({ displayPath, url }: ScannedFile): string {
  const abs = fileURLToPath(url);
  let raw: string;
  try {
    raw = readFileSync(abs, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `BAL-474 invariant source scan: could not read "${displayPath}" (resolved to "${abs}"). ` +
        'Update the path in a-no-mandate-booking-is-accepted-only-within-its-credit-at-check-time.test.ts ' +
        `rather than letting the scan silently pass. Underlying error: ${reason}`
    );
  }
  return raw
    .replace(/\/\*[^]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/\s+/g, ' ');
}

const SHARED_VERDICT = file(
  'packages/shared/src/credit/booking-funding.ts',
  '../../../shared/src/credit/booking-funding.ts'
);
const JOIN_MEETING = file(
  'apps/api/src/services/meetings/join-meeting.ts',
  '../../../../apps/api/src/services/meetings/join-meeting.ts'
);
const WEB_GATE = file(
  'apps/web/src/lib/booking/booking-funding-gate.ts',
  '../../../../apps/web/src/lib/booking/booking-funding-gate.ts'
);
const API_GUARD = file(
  'apps/api/src/services/meetings/case-booking-funding.ts',
  '../../../../apps/api/src/services/meetings/case-booking-funding.ts'
);

const MINUTE_MS = 60_000;
const RATES_CENTS_PER_HOUR: readonly number[] = [10_000, 25_000];
const WINDOWS_MINUTES: readonly number[] = [15, 30, 60, 240];
const AVAILABLES_MINOR: readonly number[] = [0, 20_000, 100_000];

/** A booking window derived from a start offset — never a hardcoded calendar date. */
function window(startOffsetMinutes: number, minutes: number): { start: Date; end: Date } {
  const base = Math.ceil(Date.now() / MINUTE_MS) * MINUTE_MS;
  const start = new Date(base + startOffsetMinutes * MINUTE_MS);
  return { start, end: new Date(start.getTime() + minutes * MINUTE_MS) };
}

function noMandateSnapshot(
  availableMinor: number,
  expertRateCents: number | null,
  reservable: readonly ReservableCaseBooking[]
): BookingFundingSnapshot {
  return { kind: 'no_mandate', walletId: 'wallet-1', expertRateCents, availableMinor, reservable };
}

function sumReserved(reservable: readonly ReservableCaseBooking[]): number {
  return reservable.reduce(
    (sum, booking) =>
      sum +
      (booking.expertRateCents === null
        ? 0
        : estimateCaseBookingMinor(
            booking.expertRateCents,
            booking.scheduledStart,
            booking.scheduledEnd
          )),
    0
  );
}

const HOLD_WITH_FIGURE: HoldStatus = {
  onHold: true,
  openReceivableCount: 1,
  confirmationWasRequested: false,
  balanceMinor: -10_000,
  promoGrantedSinceDebtMinor: 0,
  amountToClearMinor: 10_000,
};

describe('INVARIANT: a no-mandate booking is accepted only when its credit covers it at check time (ADR-1040 Amendment 7 §H)', () => {
  it('every booking the verdict accepts, checked one after another, keeps Σ reserved + this ≤ available', () => {
    const violations: string[] = [];
    let refusals = 0;
    let acceptances = 0;
    for (const availableMinor of AVAILABLES_MINOR) {
      const reservable: ReservableCaseBooking[] = [];
      let offset = 60;
      for (const rate of RATES_CENTS_PER_HOUR) {
        for (const minutes of WINDOWS_MINUTES) {
          const { start, end } = window(offset, minutes);
          offset += minutes + 30;
          const verdict = assessCaseBookingFunding(
            noMandateSnapshot(availableMinor, rate, reservable),
            { scheduledStart: start, scheduledEnd: end }
          );
          if (!verdict.ok) {
            refusals += 1;
            continue;
          }
          acceptances += 1;
          const accepted: ReservableCaseBooking = {
            meetingId: `meeting-${acceptances}`,
            scheduledStart: start,
            scheduledEnd: end,
            expertProfileId: `expert-${rate}`,
            expertRateCents: rate,
          };
          const total = sumReserved([...reservable, accepted]);
          if (total > availableMinor) {
            violations.push(`available ${availableMinor}: reserved + this = ${total}`);
          }
          reservable.push(accepted);
        }
      }
    }
    expect(violations).toEqual([]);
    // Positive controls — the sequence both accepts and refuses, so neither arm is vacuous.
    expect(acceptances).toBeGreaterThan(0);
    expect(refusals).toBeGreaterThan(0);
  });

  it('a mandate company is never refused by the reservation', () => {
    const { start, end } = window(60, 240);
    const verdict = assessCaseBookingFunding(
      { kind: 'mandate', walletId: 'wallet-1' },
      { scheduledStart: start, scheduledEnd: end }
    );
    expect(verdict).toEqual({ ok: true, arm: 'mandate' });
  });

  it('the hold beats the mandate', () => {
    // The snapshot reads the hold FIRST; an open receivable with a figure refuses even a mandate
    // company (the population the brake exists for), and a covered hold asks to be healed.
    const { start, end } = window(60, 30);
    const onHold = assessCaseBookingFunding(
      { kind: 'on_hold', walletId: 'wallet-1', hold: HOLD_WITH_FIGURE },
      { scheduledStart: start, scheduledEnd: end }
    );
    expect(onHold).toEqual({ ok: false, reason: 'account_on_hold', hold: HOLD_WITH_FIGURE });

    const covered = assessCaseBookingFunding(
      {
        kind: 'on_hold',
        walletId: 'wallet-1',
        hold: { ...HOLD_WITH_FIGURE, balanceMinor: 0, amountToClearMinor: 0 },
      },
      { scheduledStart: start, scheduledEnd: end }
    );
    expect(covered).toEqual({ ok: false, reason: 'covered_hold', walletId: 'wallet-1' });
  });

  it('boundary: available − reserved === estimate is accepted', () => {
    const rate = 33_600; // client 700 / minute at the default fee
    const planned = window(60, 30);
    const reservable: ReservableCaseBooking[] = [
      {
        meetingId: 'meeting-a',
        scheduledStart: planned.start,
        scheduledEnd: planned.end,
        expertProfileId: 'expert-a',
        expertRateCents: rate,
      },
    ];
    const next = window(180, 30);
    const estimate = estimateCaseBookingMinor(rate, next.start, next.end);
    const reserved = sumReserved(reservable);
    expect(estimate).toBe(21_000);

    const exact = assessCaseBookingFunding(
      noMandateSnapshot(reserved + estimate, rate, reservable),
      {
        scheduledStart: next.start,
        scheduledEnd: next.end,
      }
    );
    expect(exact).toEqual({ ok: true, arm: 'balance' });

    const oneShort = assessCaseBookingFunding(
      noMandateSnapshot(reserved + estimate - 1, rate, reservable),
      { scheduledStart: next.start, scheduledEnd: next.end }
    );
    expect(oneShort).toMatchObject({
      ok: false,
      reason: 'reserved_by_upcoming',
      topUpNeededMinor: 1,
      reservedBookingCount: 1,
    });
  });

  it('ONE estimator: the verdict prices with the SAME two functions that size the admission hold', () => {
    const verdict = scan(SHARED_VERDICT);
    expect(verdict).toContain('deriveSessionEstimate(');
    expect(verdict).toContain('estimatedMinutesForWindow(');

    const join = scan(JOIN_MEETING);
    expect(join).toMatch(
      /import (type )?\{[^}]*\bestimatedMinutesForWindow\b[^}]*\} from '@balo\/shared\/credit'/
    );
    expect(join).not.toContain('function estimatedMinutesForWindow');

    // Neither booking check prices a booking itself — both go through the verdict.
    expect(scan(WEB_GATE)).not.toContain('deriveSessionEstimate(');
    expect(scan(API_GUARD)).not.toContain('deriveSessionEstimate(');
  });
});
