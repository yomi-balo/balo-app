import {
  isWalletMandateActive,
  type BookingFundingSnapshot,
  type CardRemovalSnapshot,
} from '@balo/shared/credit';
import { db } from '../client';
import type { DbExecutor } from './_shared/db-executor';
import { creditHoldsRepository } from './credit-holds';
import { creditReceivablesRepository } from './credit-receivables';
import { creditWalletsRepository } from './credit-wallets';
import { expertsRepository } from './experts';
import { meetingsRepository } from './meetings';

/**
 * BAL-474 (ADR-1040 Amendment 7 §H; plan §I.2, AD-11) — THE ONE READ behind every Case booking
 * funding check. The web booking gate (`apps/web/src/lib/booking/booking-funding-gate.ts`,
 * advisory, UX + fan-out) and the `POST /meetings` guard
 * (`apps/api/src/services/meetings/case-booking-funding.ts`, defence in depth) both call
 * {@link bookingFundingRepository.readSnapshot} and hand the result to the ONE pure verdict,
 * `assessCaseBookingFunding` (`@balo/shared/credit`). Nothing here decides anything.
 *
 * ⚠⚠ ONE SNAPSHOT, NOT SIX READS (D8.5, V1-F2). Every read below runs inside ONE
 * `REPEATABLE READ, READ ONLY` transaction and on THAT transaction's executor — including the
 * holds sum, which used to read on the bare `db` inside `getAvailableBalance` and would have torn
 * the snapshot even with an executor passed. A top-up, a hold or a new booking committing between
 * two reads can therefore never produce a verdict computed from two different moments (a hold
 * with a zero figure; a reservation that counts a meeting whose hold is also inside `available`).
 *
 * ⚠ UNLOCKED, BY DESIGN (D6.5 — a CHECK-TIME soft reservation, not a ledger hold). No advisory
 * lock is taken, so two simultaneous bookings by one company can both pass; the overshoot is
 * bounded by the bookings submitted at the same instant, and anything that slips through is
 * billed session-scoped at admission and braked at the next booking (§I.5).
 *
 * THE ORDER (plan §I.2): wallet → hold status → mandate → expert rate → available → reservable
 * bookings. The hold is read BEFORE the mandate so a mandate holder on hold is braked (D6.1), and
 * a live mandate then short-circuits the rate, balance and reservation reads (D6.5 — the card
 * funds anything above the credit).
 *
 * `repositories-never-notify`: this file publishes nothing and logs nothing.
 */

export interface BookingFundingSnapshotInput {
  /** The billing company — the engagement's company (one wallet per company). */
  readonly companyId: string;
  /** The expert being booked — their CURRENT rate prices this booking. */
  readonly expertProfileId: string;
  /** Bookings whose window ends at or before `now` are no longer "upcoming". */
  readonly now: Date;
}

export interface CardRemovalSnapshotInput {
  /** The billing company — the wallet's owner (one wallet per company). */
  readonly companyId: string;
  /** Bookings whose window ends at or before `now` are no longer "upcoming". */
  readonly now: Date;
}

/**
 * The snapshot body, on a caller-supplied executor. Exported for the two-connection concurrency
 * proof (`booking-funding.concurrency.integration.test.ts`), which must run it on its OWN
 * repeatable-read transaction: under the single-connection integration harness a nested
 * `transaction()` is a SAVEPOINT that silently drops the isolation config, so the isolation can
 * only be observed across real connections. Production calls {@link bookingFundingRepository.readSnapshot}.
 */
export async function readSnapshotInTx(
  tx: DbExecutor,
  input: BookingFundingSnapshotInput
): Promise<BookingFundingSnapshot> {
  const wallet = await creditWalletsRepository.findByCompanyId(input.companyId, tx);
  if (wallet === undefined) {
    return { kind: 'no_wallet' };
  }

  // D6.1 — the hold BEFORE the mandate (an open receivable brakes a mandate holder too).
  const hold = await creditReceivablesRepository.readHoldStatus({ walletId: wallet.id }, tx);
  if (hold.onHold) {
    return { kind: 'on_hold', walletId: wallet.id, hold };
  }

  // D6.5 — a live mandate funds anything above the credit; nothing below it is read.
  if (isWalletMandateActive(wallet)) {
    return { kind: 'mandate', walletId: wallet.id };
  }

  const expert = await expertsRepository.findRateCentsById(input.expertProfileId, tx);
  if (expert === undefined) {
    return { kind: 'unknown_expert', walletId: wallet.id };
  }

  const availableMinor = await creditHoldsRepository.getAvailableForBooking(wallet.id, tx);
  const reservable = await meetingsRepository.listReservableCaseBookings(
    { companyId: input.companyId, now: input.now },
    tx
  );

  return {
    kind: 'no_mandate',
    walletId: wallet.id,
    expertRateCents: expert.rateCents,
    availableMinor,
    reservable,
  };
}

/**
 * The card-removal snapshot body (owner ruling D10.6), on a caller-supplied executor — the sibling
 * of {@link readSnapshotInTx}, built from the SAME reads: the wallet, the NETTED available balance
 * (`getAvailableForBooking`) and the reservable-bookings finder.
 *
 * It exists because {@link readSnapshotInTx} short-circuits at an active mandate and reads no
 * figures below it, while removing the card is exactly the act that must be judged as if the
 * mandate were gone. Nothing here changes what the booking snapshot reads.
 *
 * The hold is NOT read: `detachSavedCard` refuses an open receivable before it asks this.
 * `expertProfileId` is not needed either — the reservable set is the company's whole upcoming
 * Case schedule, priced at each booked expert's own rate. A wallet without an active mandate
 * short-circuits before the balance and the finder are read.
 */
export async function readCardRemovalSnapshotInTx(
  tx: DbExecutor,
  input: CardRemovalSnapshotInput
): Promise<CardRemovalSnapshot> {
  const wallet = await creditWalletsRepository.findByCompanyId(input.companyId, tx);
  if (wallet === undefined) {
    return { kind: 'no_wallet' };
  }
  if (!isWalletMandateActive(wallet)) {
    return { kind: 'no_mandate', walletId: wallet.id };
  }
  const availableMinor = await creditHoldsRepository.getAvailableForBooking(wallet.id, tx);
  const reservable = await meetingsRepository.listReservableCaseBookings(
    { companyId: input.companyId, now: input.now },
    tx
  );
  return { kind: 'mandate', walletId: wallet.id, availableMinor, reservable };
}

export const bookingFundingRepository = {
  /**
   * ONE consistent read of what a card removal must be checked against (owner ruling D10.6) — see
   * {@link readCardRemovalSnapshotInTx}. Same `REPEATABLE READ, READ ONLY` transaction as
   * {@link bookingFundingRepository.readSnapshot}.
   */
  async readCardRemovalSnapshot(input: CardRemovalSnapshotInput): Promise<CardRemovalSnapshot> {
    return db.transaction((tx) => readCardRemovalSnapshotInTx(tx, input), {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    });
  },

  /**
   * ONE consistent read of a company's Case booking funding — see the module docblock. Runs in
   * its OWN `REPEATABLE READ, READ ONLY` transaction on the base client.
   */
  async readSnapshot(input: BookingFundingSnapshotInput): Promise<BookingFundingSnapshot> {
    return db.transaction((tx) => readSnapshotInTx(tx, input), {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    });
  },
};
