/**
 * BAL-474 (ADR-1040 Amendment 7 §H, D6.1, D6.5, D7.7, D8.1) — THE API'S CASE-BOOKING FUNDING GUARD.
 *
 * `POST /meetings` re-checks, for a Case, the SAME funding verdict the web booking gate ran — and
 * Call now runs it too: `startCallNow` for a client-started ring, `answerCallNow` when the client
 * commits to an expert-started one — one
 * snapshot read (`bookingFundingRepository.readSnapshot`) and one pure verdict
 * (`assessCaseBookingFunding`), shared with the web so the two cannot drift. It is DEFENCE IN DEPTH:
 * the web gate is advisory (unlocked, check-time) and owns the billing-admin fan-out and analytics;
 * on the current tree no browser holds a Bearer token, so the funding rules do not depend on that
 * staying true only because this guard exists.
 *
 * ⚠ NO SIDE EFFECTS BUT THE HEAL. No fan-out and no analytics here: the web re-runs its gate on the
 * 409 and is the single emitter. The one exception is the heal's own "account clear" notice, which is
 * a CREDIT event published by the heal itself.
 *
 * ⚠⚠ A COVERED HOLD IS HEALED, NEVER SHOWN (D8.1). A hold whose debt the balance already covers
 * (the top-up figure is 0) must not refuse a booking. This guard calls `healCoveredHoldNow` — the
 * locked coverage clear, whose ONE home is `services/credit/receivable-coverage.ts` — and re-runs the
 * verdict ONCE. A second `covered_hold` after a successful heal is treated as an open hold; a heal that
 * throws is `warn` + Sentry and the answer is `account_on_hold` (the hold is still open, and the brake
 * applies to an open hold).
 *
 * ⚠ FAILS CLOSED. A snapshot that cannot be read (or a wallet-less `unknown_expert`, unreachable here
 * because the expert comes from the gate's own engagement row) is `booking_funding_unavailable` (503),
 * mirroring the web gate's `unavailable`.
 */
import * as Sentry from '@sentry/node';
import { bookingFundingRepository } from '@balo/db';
import {
  assessCaseBookingFunding,
  suggestCaseBookingTopUpMinor,
  type BookingFundingSnapshot,
  type CaseBookingFundingVerdict,
} from '@balo/shared/credit';
import { createLogger } from '@balo/shared/logging';
import { healCoveredHoldNow } from '../credit-session/notify.js';

const log = createLogger('case-booking-funding');

/** The four literals a refused Case booking (or Call now commit) answers, BEFORE any write. */
export type CaseBookingFundingCode =
  | 'account_on_hold'
  | 'booking_unfunded'
  | 'booking_reserved'
  | 'booking_funding_unavailable';

/**
 * The refusal arm carries the client's all-in top-up figure (`suggestCaseBookingTopUpMinor`, over the
 * snapshot that produced the final verdict). It is `null` for `booking_funding_unavailable` and for a
 * covered hold whose heal failed — no figure is better than a wrong one.
 */
export type CaseBookingFundingResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: CaseBookingFundingCode;
      readonly suggestedTopUpMinor: number | null;
    };

/**
 * HTTP status per refusal code. Exhaustive BY TYPE, so a new literal is a compile error rather than a
 * silent 500. The three refusals are 409; an unreadable snapshot FAILS CLOSED as 503.
 */
export const CASE_BOOKING_FUNDING_STATUS: Record<CaseBookingFundingCode, 409 | 503> = {
  account_on_hold: 409,
  booking_unfunded: 409,
  booking_reserved: 409,
  booking_funding_unavailable: 503,
};

export interface CaseBookingFundingInput {
  readonly companyId: string;
  readonly expertProfileId: string;
  readonly scheduledStart: Date;
  readonly scheduledEnd: Date;
  readonly now: Date;
  /** A meeting left out of the reserved total — a Call now's own meeting (see the repository). */
  readonly excludeMeetingId?: string;
}

interface ReadVerdict {
  readonly snapshot: BookingFundingSnapshot;
  readonly verdict: CaseBookingFundingVerdict;
}

/** A verdict that is NOT a covered hold → the wire code (or `ok`). */
function resultForVerdict(
  { snapshot, verdict }: ReadVerdict,
  input: CaseBookingFundingInput
): CaseBookingFundingResult {
  if (verdict.ok) {
    return { ok: true };
  }
  const code = codeForRefusal(verdict);
  const suggestedTopUpMinor =
    code === 'booking_funding_unavailable'
      ? null
      : suggestCaseBookingTopUpMinor(snapshot, {
          scheduledStart: input.scheduledStart,
          scheduledEnd: input.scheduledEnd,
        });
  return { ok: false, code, suggestedTopUpMinor };
}

/** A refused verdict → the wire code. */
function codeForRefusal(
  verdict: Exclude<CaseBookingFundingVerdict, { ok: true }>
): CaseBookingFundingCode {
  switch (verdict.reason) {
    case 'account_on_hold':
    case 'covered_hold':
      // A covered hold that survived its heal is an open hold — the brake applies to it.
      return 'account_on_hold';
    case 'reserved_by_upcoming':
      return 'booking_reserved';
    case 'no_wallet':
    case 'no_mandate_insufficient_balance':
      return 'booking_unfunded';
    default:
      // `unknown_expert` — unreachable (the expert is the gate's own engagement row); fail closed.
      return 'booking_funding_unavailable';
  }
}

/**
 * The verdict's figures, for the refusal log — so a web/API disagreement (the two clients compute the
 * same verdict from separate reads) can be diagnosed from the API's own line. Only the arms that carry
 * a figure contribute one.
 */
function verdictFigures(verdict: CaseBookingFundingVerdict): Record<string, number> {
  if (verdict.ok) {
    return {};
  }
  switch (verdict.reason) {
    case 'account_on_hold':
      return { amountToClearMinor: verdict.hold.amountToClearMinor };
    case 'no_mandate_insufficient_balance':
      return { estimateMinor: verdict.estimateMinor, availableMinor: verdict.availableMinor };
    case 'reserved_by_upcoming':
      return {
        estimateMinor: verdict.estimateMinor,
        availableMinor: verdict.availableMinor,
        reservedMinor: verdict.reservedMinor,
        reservedBookingCount: verdict.reservedBookingCount,
        topUpNeededMinor: verdict.topUpNeededMinor,
      };
    default:
      return {};
  }
}

/**
 * Heal a covered hold and re-run the verdict once. Returns the verdict to map, or `null` when the
 * heal threw (the caller answers `account_on_hold`).
 */
async function healThenReverdict(
  walletId: string,
  input: CaseBookingFundingInput
): Promise<ReadVerdict | null> {
  try {
    const healed = await healCoveredHoldNow({
      walletId,
      trigger: 'booking_guard',
      now: input.now,
    });
    log.info({ walletId, healed: healed.healed }, 'Booking guard healed a covered hold');
  } catch (error: unknown) {
    log.warn(
      {
        walletId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'Booking guard could not heal a covered hold — the brake applies to it'
    );
    Sentry.captureException(error, { extra: { walletId, op: 'booking_guard_heal' } });
    return null;
  }
  return readVerdict(input);
}

/** One read + one verdict — the same two calls the web gate makes. */
async function readVerdict(input: CaseBookingFundingInput): Promise<ReadVerdict> {
  const snapshot = await bookingFundingRepository.readSnapshot({
    companyId: input.companyId,
    expertProfileId: input.expertProfileId,
    now: input.now,
    excludeMeetingId: input.excludeMeetingId,
  });
  const verdict = assessCaseBookingFunding(snapshot, {
    scheduledStart: input.scheduledStart,
    scheduledEnd: input.scheduledEnd,
  });
  return { snapshot, verdict };
}

/**
 * The refusal line, carrying the verdict's figures. `unknown_expert` is unreachable by construction
 * (the expert is the tenancy gate's own engagement row) but 503s EVERY booking for the pair when
 * reached, so it is an error, not an info line.
 */
function logRefusal(
  input: CaseBookingFundingInput,
  verdict: CaseBookingFundingVerdict,
  code: CaseBookingFundingCode
): void {
  const fields = {
    companyId: input.companyId,
    expertProfileId: input.expertProfileId,
    code,
    reason: verdict.ok ? undefined : verdict.reason,
    ...verdictFigures(verdict),
  };
  if (!verdict.ok && verdict.reason === 'unknown_expert') {
    log.error(
      fields,
      'Case booking funding verdict named an unknown expert — refusing every booking for this pair'
    );
    return;
  }
  log.info(fields, 'Case booking refused before any write — funding pre-condition unmet');
}

/**
 * Should THIS Case booking be refused for funding? See the module docblock. `ok: true` ⇒ proceed to
 * the booking; otherwise the route answers `code` (409 for the first three, 503 for `unavailable`).
 */
export async function checkCaseBookingFunding(
  input: CaseBookingFundingInput
): Promise<CaseBookingFundingResult> {
  try {
    let read = await readVerdict(input);
    if (!read.verdict.ok && read.verdict.reason === 'covered_hold') {
      const rerun = await healThenReverdict(read.verdict.walletId, input);
      if (rerun === null) {
        log.info(
          { companyId: input.companyId, expertProfileId: input.expertProfileId },
          'Case booking refused — an open hold the balance covers could not be healed'
        );
        return { ok: false, code: 'account_on_hold', suggestedTopUpMinor: null };
      }
      read = rerun;
    }
    const result = resultForVerdict(read, input);
    if (!result.ok) {
      logRefusal(input, read.verdict, result.code);
    }
    return result;
  } catch (error: unknown) {
    log.error(
      {
        companyId: input.companyId,
        expertProfileId: input.expertProfileId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'Case booking funding snapshot could not be read — failing CLOSED'
    );
    return { ok: false, code: 'booking_funding_unavailable', suggestedTopUpMinor: null };
  }
}
