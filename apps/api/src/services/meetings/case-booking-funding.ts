/**
 * BAL-474 (ADR-1040 Amendment 7 §H, D6.1, D6.5, D7.7, D8.1) — THE API'S CASE-BOOKING FUNDING GUARD.
 *
 * `POST /meetings` re-checks, for a Case, the SAME funding verdict the web booking gate ran — one
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
import { assessCaseBookingFunding, type CaseBookingFundingVerdict } from '@balo/shared/credit';
import { createLogger } from '@balo/shared/logging';
import { healCoveredHoldNow } from '../credit-session/notify.js';

const log = createLogger('case-booking-funding');

/** The four literals `POST /meetings` answers, BEFORE any write, when a Case booking is refused. */
export type CaseBookingFundingCode =
  | 'account_on_hold'
  | 'booking_unfunded'
  | 'booking_reserved'
  | 'booking_funding_unavailable';

export type CaseBookingFundingResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: CaseBookingFundingCode };

export interface CaseBookingFundingInput {
  readonly companyId: string;
  readonly expertProfileId: string;
  readonly scheduledStart: Date;
  readonly scheduledEnd: Date;
  readonly now: Date;
}

/** A verdict that is NOT a covered hold → the wire code (or `ok`). */
function codeForVerdict(verdict: CaseBookingFundingVerdict): CaseBookingFundingResult {
  if (verdict.ok) {
    return { ok: true };
  }
  switch (verdict.reason) {
    case 'account_on_hold':
    case 'covered_hold':
      // A covered hold that survived its heal is an open hold — the brake applies to it.
      return { ok: false, code: 'account_on_hold' };
    case 'reserved_by_upcoming':
      return { ok: false, code: 'booking_reserved' };
    case 'no_wallet':
    case 'no_mandate_insufficient_balance':
      return { ok: false, code: 'booking_unfunded' };
    default:
      // `unknown_expert` — unreachable (the expert is the gate's own engagement row); fail closed.
      return { ok: false, code: 'booking_funding_unavailable' };
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
): Promise<CaseBookingFundingVerdict | null> {
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
async function readVerdict(input: CaseBookingFundingInput): Promise<CaseBookingFundingVerdict> {
  const snapshot = await bookingFundingRepository.readSnapshot({
    companyId: input.companyId,
    expertProfileId: input.expertProfileId,
    now: input.now,
  });
  return assessCaseBookingFunding(snapshot, {
    scheduledStart: input.scheduledStart,
    scheduledEnd: input.scheduledEnd,
  });
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
    let verdict = await readVerdict(input);
    if (!verdict.ok && verdict.reason === 'covered_hold') {
      const rerun = await healThenReverdict(verdict.walletId, input);
      if (rerun === null) {
        log.info(
          { companyId: input.companyId, expertProfileId: input.expertProfileId },
          'Case booking refused — an open hold the balance covers could not be healed'
        );
        return { ok: false, code: 'account_on_hold' };
      }
      verdict = rerun;
    }
    const result = codeForVerdict(verdict);
    if (!result.ok) {
      logRefusal(input, verdict, result.code);
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
    return { ok: false, code: 'booking_funding_unavailable' };
  }
}
