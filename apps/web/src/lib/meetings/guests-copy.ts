import { MAX_MEETING_PARTICIPANTS } from '@balo/shared/meetings';

/**
 * BAL-436 — the api's FIXED ERROR LITERALS mapped to user-facing copy, in ONE place.
 *
 * ⚠⚠ IT IS A PLAIN MODULE, NOT A `'use server'` FILE, FOR THE REASON `lobby.ts` AND
 * `guests-poll.ts` BOTH EXIST: a `'use server'` module may export ONLY async functions, so an
 * `export const` there fails `next build` while `tsc`, eslint and vitest all pass. Four Server
 * Actions share this table; inlining it into each would be four copies of the same strings —
 * a maintenance hazard AND a SonarCloud new-code duplication finding.
 *
 * ── ⚠⚠ THE COPY RULES THIS TABLE HAS TO KEEP ────────────────────────────────────────────
 *
 *   · **NEVER `err.message`.** The api returns fixed literals precisely so a UI maps them to
 *     copy instead of surfacing prose (`routes/meetings/guests.ts` contract point 7).
 *   · **NO SENTENCE MAY IMPLY A 403.** There is no 403 anywhere on that surface: it collapses
 *     "no such meeting", "not your party", "unresolvable context" and "not a host" into one
 *     literal. Copy that said "you don't have permission" would invent a distinction the api
 *     deliberately refuses to make — and would be wrong for three of those four cases.
 *   · **GENDER-NEUTRAL, AND NEVER ADVERSARIAL.** These render on a live call, to somebody
 *     trying to get a colleague into a room.
 */

/** ⚠ Everything the four guest actions can be told, plus the two transport-shaped answers. */
export type GuestActionErrorCode =
  | 'meeting_not_found'
  | 'meeting_not_open_for_guests'
  | 'participant_cap_reached'
  | 'guest_already_invited'
  | 'delegate_must_be_client_side'
  | 'guest_not_found'
  | 'guest_not_pending'
  | 'guest_link_not_resendable'
  | 'lobby_queue_full'
  | 'rate_limited'
  | 'rate_limit_unavailable'
  | 'unauthenticated'
  | 'request_failed';

/**
 * ⚠ EVERY MESSAGE IS A FACT ABOUT THE ROSTER, NOT ABOUT THE VIEWER'S RIGHTS.
 *
 * `guest_not_pending` is the two-hosts RACE outcome, and its wording says so — the panel
 * renders it as an INFORMATIONAL toast plus a refetch, never as a failure, because the
 * outcome the host wanted has happened either way.
 *
 * `lobby_queue_full` is safe to surface TO A HOST (it is their own meeting) and it names the
 * control that fixes it, because a host facing a flood otherwise has no idea a deny frees a
 * slot.
 */
export const GUEST_ACTION_COPY: Readonly<Record<GuestActionErrorCode, string>> = {
  meeting_not_found: 'This meeting is no longer available.',
  meeting_not_open_for_guests: 'This call is closed to new people now.',
  participant_cap_reached: `This call is full — ${MAX_MEETING_PARTICIPANTS} people is the limit.`,
  guest_already_invited: "They're already on the list.",
  // ⚠ NOT REACHABLE FROM THIS PANEL — it never sends `participationRole`, so the api can never
  // answer this. Mapped anyway: the table is exhaustive over the wire vocabulary by type, so a
  // literal that becomes reachable later cannot ship without copy.
  delegate_must_be_client_side: 'That kind of invite is not available here.',
  guest_not_found: 'That person is no longer in the list.',
  guest_not_pending: 'Someone else already decided this.',
  guest_link_not_resendable: "There's no link to re-send for this person.",
  lobby_queue_full: 'The waiting list is full — deny someone to free a slot.',
  rate_limited: "You've done that a lot just now. Try again in a few minutes.",
  /**
   * ⚠⚠ **DISTINCT FROM `request_failed`, DELIBERATELY, EVEN THOUGH BOTH MEAN "OUR SIDE".**
   *
   * The two were byte-identical, which made three branches of {@link guestActionCopyFor}
   * INDISTINGUISHABLE FROM EACH OTHER by any test: deleting the `status >= 500` arm, the
   * `status === 0` arm, or both, left the suite green because every path resolved to the same
   * sentence anyway. Copy that cannot be told apart is copy whose routing cannot be tested.
   *
   * ⚠ IT IS ALSO UNREACHABLE THROUGH {@link guestActionCopyFor}: a `503` is caught by the
   * `status >= 500` arm first. The entry exists because the table is exhaustive over the wire
   * vocabulary BY TYPE — a literal that becomes reachable later cannot ship without copy — and
   * because a direct `GUEST_ACTION_COPY.rate_limit_unavailable` lookup is legal.
   */
  rate_limit_unavailable: 'The call service is busy right now. Try again in a moment.',
  request_failed: "We couldn't reach the call service. Try again in a moment.",
  unauthenticated: 'Please sign in and try again.',
};

/**
 * The rate-limit line WITH a real number when the api gave us one.
 *
 * ⚠ MINUTES, ROUNDED **UP**, AND NEVER ZERO. "Try again in 0 minutes" is worse than the
 * generic line; a 40-second cooldown honestly reads as "a minute".
 */
export function rateLimitedCopy(retryAfterSeconds?: number): string {
  if (retryAfterSeconds === undefined || retryAfterSeconds <= 0) {
    return GUEST_ACTION_COPY.rate_limited;
  }
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `You've done that a lot just now. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

/**
 * Map one api answer to copy.
 *
 * ⚠ THE STATUS IS CONSULTED BEFORE THE LITERAL, and the order matters: `status: 0` (transport)
 * and any `>= 500` carry whatever literal the body happened to have — often none at all — and
 * must resolve to the retryable line rather than to whatever that literal maps to.
 *
 * ⚠⚠ `guests-copy.test.ts` EXERCISES EVERY STATUS ARM WITH A `code` THAT MAPS **ELSEWHERE**,
 * and that is not pedantry: while the status arms were tested with codes that happened to
 * resolve to the same sentence anyway, all three arms were deletable with the suite green.
 */
export function guestActionCopyFor(input: {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSeconds?: number;
}): string {
  if (input.status === 429) return rateLimitedCopy(input.retryAfterSeconds);
  if (input.status === 0 || input.status >= 500) return GUEST_ACTION_COPY.request_failed;
  if (input.status === 401) return GUEST_ACTION_COPY.unauthenticated;
  const known = Object.hasOwn(GUEST_ACTION_COPY, input.code)
    ? GUEST_ACTION_COPY[input.code as GuestActionErrorCode]
    : undefined;
  return known ?? GUEST_ACTION_COPY.request_failed;
}
