/**
 * BAL-378 (ADR-1040 Lane 2) — pure settlement helpers shared by `endSession`, the reaper's
 * stuck-settlement reconciliation, and the meter driver. No I/O beyond the pure
 * `deriveIdempotencyKey` derivation.
 */
import { deriveIdempotencyKey } from '@balo/db';

/**
 * The state-derived idempotency key for a session's overdraft settlement — passed as BOTH the
 * Stripe idempotency key AND the webhook metadata, so at most ONE settlement PI exists per
 * session (the reaper reconciliation reuses it → Stripe returns the same PI, no double-charge)
 * and the credit dedups on the same ledger key.
 */
export function settlementIdempotencyKey(sessionId: string): string {
  return deriveIdempotencyKey({ reason: 'overdraft_settlement', sessionId });
}

/** Grace-remaining whole minutes before the 30-min bound (0 once past it). */
export function graceRemainingMinutes(
  session: { graceEnteredAt: Date | null; graceBoundMinutes: number },
  now: Date
): number {
  if (session.graceEnteredAt === null) {
    return session.graceBoundMinutes;
  }
  const elapsed = Math.floor((now.getTime() - session.graceEnteredAt.getTime()) / 60_000);
  return Math.max(0, session.graceBoundMinutes - elapsed);
}

/** AUD-minor room left before the overdraft ceiling (0 once at/over it). */
export function ceilingRoomMinor(
  session: { effectiveCeilingMinor: number },
  balanceMinor: number
): number {
  const used = balanceMinor < 0 ? -balanceMinor : 0;
  return Math.max(0, session.effectiveCeilingMinor - used);
}

/**
 * BAL-412 (D6) — `runwayMinutes` WAS HERE and is DELETED. It computed `floor(balance / rate)`
 * with no awareness of the ADR-1044 §7 fifteen-minute billing floor, which OVERSTATED
 * discretionary runway early in a session (the balance still has to cover the unconsumed
 * remainder of the floor before anything beyond it is truly discretionary — the same defect
 * `drawdown-state.ts`'s module-private copy carried). The ONE corrected implementation is
 * `minutesOfRunway` in `@balo/shared/credit/runway` — import it directly; do NOT re-add a
 * re-export alias here (two names for one function is how the second copy came back before).
 */

/** Terminal negative-balance magnitude (0 when in credit). */
export function overdraftMagnitude(balanceMinor: number): number {
  return balanceMinor < 0 ? -balanceMinor : 0;
}
