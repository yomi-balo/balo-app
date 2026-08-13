import { LOBBY_MAX_CONSECUTIVE_POLL_FAILURES } from './lobby';
import { pollIntervalFor } from './use-admission-poll';

/**
 * BAL-435 — the member route's auto-retry POLICY for a not-yet-provisioned meeting (API `503`).
 *
 * ⚠⚠ IT REUSES THE SHIPPED CADENCE RATHER THAN WRITING A SECOND ONE. `pollIntervalFor` is
 * already EXPORTED from `use-admission-poll.ts` for exactly this, and
 * `LOBBY_MAX_CONSECUTIVE_POLL_FAILURES` already bounds the give-up. Two cadences for "wait, then
 * ask again" is how they disagree later.
 *
 * ⚠ THE *HOOK* `useAdmissionPoll` IS NOT REUSED, DELIBERATELY: it is guest-token-shaped (it
 * calls `pollGuestAdmissionAction` with a raw token). The POLICY is the reusable part, and the
 * policy is what must not fork.
 *
 * ⚠ PURE, so the schedule is testable without timers.
 */

/** How many consecutive failures before the retry becomes manual only. */
export const MEMBER_JOIN_MAX_ATTEMPTS = LOBBY_MAX_CONSECUTIVE_POLL_FAILURES;

/**
 * The delay before the next automatic attempt, or `null` once the budget is spent.
 *
 * `failureCount` is the number of attempts that have ALREADY failed; `waitedMs` is how long the
 * viewer has been waiting, which is what drives the shipped 5s → 15s back-off.
 */
export function memberJoinRetryDelayMs(failureCount: number, waitedMs: number): number | null {
  if (failureCount >= MEMBER_JOIN_MAX_ATTEMPTS) return null;
  return pollIntervalFor(waitedMs);
}

/**
 * ⚠ THE ONE EXTRA LINE THE CARD GAINS ONCE AUTOMATIC RETRYING HAS STOPPED. The card itself stays
 * and its "Try again" button stays live — giving up on the schedule is not giving up on the
 * person.
 */
export const MEMBER_JOIN_EXHAUSTED_LINE =
  "Still nothing. You can try again, or head back — we'll email you when it's ready.";
