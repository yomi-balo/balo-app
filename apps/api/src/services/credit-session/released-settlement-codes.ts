/**
 * BAL-474 — THE TERMINAL "RELEASED, NOTHING IS OWED" REFUSALS of a presence settlement, in one pure place.
 *
 * `settleSessionFromPresence` returns one of these when it cancelled a session and marked its meeting
 * `not_billable` instead of billing it. All three terminal paths (the human End, the lifecycle sweep, the
 * durability backstop) treat them identically: an `info` line, never a "the backstop will retry" warn and
 * never a retry. They read this predicate rather than restating the list, so a new released code is added once.
 *
 * ⚠ IT IS ITS OWN MODULE, NOT AN EXPORT OF `settle-from-presence.ts`: the three callers' tests mock that
 * module, and a partial mock would hide a predicate exported from it (memory
 * `reference_vitest_clearallmocks_and_partial_mocks`).
 */

/**
 * - `released_closed_case_no_show` (D12.1c): a no-show on a case the client closed BEFORE the start.
 * - `released_expert_invited_guest_only` (R6F-4c, ADR-1040 Amendment 7 §E): a `held` call attended only by
 *   client-party guests the delivering expert invited.
 */
export const RELEASED_SETTLEMENT_CODES = [
  'released_closed_case_no_show',
  'released_expert_invited_guest_only',
] as const;

export type ReleasedSettlementCode = (typeof RELEASED_SETTLEMENT_CODES)[number];

export function isReleasedSettlementCode(code: string): code is ReleasedSettlementCode {
  return (RELEASED_SETTLEMENT_CODES as readonly string[]).includes(code);
}
