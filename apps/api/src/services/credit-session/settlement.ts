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

/** Whole minutes of funded runway left (0 when the balance is non-positive / rate unknown). */
export function runwayMinutes(balanceMinor: number, ratePerMinuteMinor: number): number {
  if (ratePerMinuteMinor <= 0 || balanceMinor <= 0) {
    return 0;
  }
  return Math.floor(balanceMinor / ratePerMinuteMinor);
}

/** Terminal negative-balance magnitude (0 when in credit). */
export function overdraftMagnitude(balanceMinor: number): number {
  return balanceMinor < 0 ? -balanceMinor : 0;
}
