import type { MemberJoinFailureReason } from './member-join-failure';
import { LOBBY_MAX_CONSECUTIVE_POLL_FAILURES } from './lobby';
import { pollIntervalFor } from './use-admission-poll';

/**
 * BAL-435 / BAL-581 — the member route's auto-retry POLICY for a member join that is worth
 * retrying: a transport failure or 5xx (`outage`), or a meeting whose call room is still being
 * set up (API `409 meeting_not_provisioned`). `meeting_not_provisioned` has shipped as a `409`
 * since `ee5fce50` (BAL-132) and is never reachable as a `503`, so retrying on the `409` is what
 * actually reaches an unprovisioned room.
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
 *
 * ⚠ `MemberJoinFailureReason` IS IMPORTED **TYPE-ONLY**. `member-join-failure.ts` value-imports
 * `isAccountRefusalCode` from `@balo/shared/authz`, so only the server action (`join-as-member.ts`)
 * value-imports that module; this client-bundled file and `call-client.tsx` never do.
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
 * Which of the five {@link MemberJoinFailureReason}s the call page auto-retries on the schedule
 * above. `not_open` and `unavailable` are terminal (nothing changes about them by waiting) and
 * `account_refused` routes to session-sync instead of rendering a retry card at all.
 */
export function isRetryableMemberJoinFailure(reason: MemberJoinFailureReason): boolean {
  return reason === 'outage' || reason === 'not_provisioned';
}

/**
 * ⚠ THE ONE EXTRA LINE THE CARD GAINS ONCE AUTOMATIC RETRYING HAS STOPPED. The card itself stays
 * and its "Try again" button stays live — giving up on the schedule is not giving up on the
 * person.
 *
 * ⚠ NO EMAIL PROMISE — auto-retry stops after ~8 attempts on the shipped cadence (~35s), and
 * nothing sends an email when a room becomes ready, so the line must never claim one is coming.
 */
export const MEMBER_JOIN_EXHAUSTED_LINE =
  'Still nothing. You can try again, or head back to your dashboard.';
