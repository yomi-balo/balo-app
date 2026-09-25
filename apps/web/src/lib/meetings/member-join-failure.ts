import { isAccountRefusalCode } from '@balo/shared/authz';

/**
 * BAL-581 — why a signed-in member's join did not produce a grant.
 *
 * ⚠⚠ MAPPED BY AN ALLOWLIST ON THE API'S `(status, code)` — ANYTHING NOT LISTED COLLAPSES TO
 * `unavailable`. The authority for distinguishing these five is the API's own docblock at
 * `apps/api/src/services/meetings/join-meeting.ts:31-42`: every code below `404`
 * (`meeting_not_found`, the one pre-authorization code) is reachable ONLY after
 * `authorizeMeetingParticipation` has already succeeded for this actor on this meeting, so naming
 * which one fired leaks nothing a guest link's anonymity depends on — there is no guest link
 * here, only an already-authorized member.
 */
export type MemberJoinFailureReason =
  | 'not_provisioned' // 409 meeting_not_provisioned — the call room is still being set up (retry)
  | 'not_open' // 409 meeting_not_open_for_join — ended/cancelled/window closed (terminal)
  | 'outage' // transport (0) or any 5xx, or an unreadable account row (retry)
  | 'account_refused' // suspended/deleted account (BAL-568) → session-sync
  | 'unavailable'; // 404, plain 401, synthetic `unauthenticated`, invalid request, anything else

/**
 * THE ALLOWLIST. Only facts the api may disclose post-authorization are distinguished; everything
 * else — including a 429, which this route never actually sends (it carries no rate limit,
 * `join.ts:411-419`) — collapses to `unavailable` per the binding ruling.
 */
export function memberJoinFailureReasonFor(status: number, code: string): MemberJoinFailureReason {
  if (status === 0 || status >= 500) return 'outage';
  if (status === 409 && code === 'meeting_not_provisioned') return 'not_provisioned';
  if (status === 409 && code === 'meeting_not_open_for_join') return 'not_open';
  if (status === 401 && isAccountRefusalCode(code)) return 'account_refused';
  return 'unavailable';
}
