/**
 * BAL-476 (R5 amended) — WHY IS THIS GUEST OUT OF THE CALL?
 *
 * PURE — no I/O, no React — which is what makes the rule below a unit test rather than a
 * component test, and what keeps it to ONE definition. ⚠ Do not inline this branch in the frame,
 * in the Server Action and in the api client: three spellings of one rule is how they disagree.
 *
 * ── WHY THE SERVER HAS TO BE ASKED AT ALL ────────────────────────────────────────────────
 *
 * daily-js reports a host-ended eject and a targeted removal IDENTICALLY: `endForEveryone` calls
 * `updateParticipants({ '*': { eject: true } })`, so every remaining participant of a normally
 * ended call is ejected too, and `left-meeting` carries no reason. The ejection EVENT is
 * therefore not a discriminator and nothing derived from it may be used as one.
 *
 * **The refusal the person's own credential now produces IS one.** A removed guest's token stops
 * resolving (`findLiveByTokenHash` filters `deleted_at IS NULL AND revoked_at IS NULL`, and
 * `revoke` stamps BOTH in one statement) ⇒ `404 meeting_not_found`. A host-ended meeting's token
 * keeps resolving for `GUEST_TOKEN_TTL_AFTER_END_MS` while `assertMeetingJoinable` refuses it
 * ⇒ `409 meeting_not_open_for_join`.
 */

export type GuestExitCause = 'removed' | 'host_ended' | 'access_ended';

/**
 * ⚠⚠ **THE DEFAULT ARM IS `access_ended`, AND THAT IS THE WHOLE RULE.** Anything we did not
 * POSITIVELY confirm — a transport failure, a timeout, a 429, a 503, a 500, a 200, a 400 —
 * resolves to the VAGUER card. We never fall back to a wrong SPECIFIC claim. If we cannot
 * determine why somebody is out of a call, we say LESS, not something false.
 *
 * ⚠ `404` ⇒ `removed` and `409` ⇒ `host_ended` are the ONLY two positive answers.
 *
 * ⚠ THE 404 ⇒ `removed` GUARANTEE IS **DERIVED, NOT STRUCTURAL**, and it is pinned by a test.
 * `findLiveByTokenHash` also filters expired tokens, `denied` admission, soft-deleted meetings
 * and CANCELLED meetings — but on the terminal transition of a call somebody was actually IN,
 * none of those is reachable: a `denied` guest was never in the room, the token TTL is
 * `scheduled_end + 7 days` so it cannot lapse mid-call, and a meeting cannot flip to `cancelled`
 * once anybody has joined (both cancel writers compare-and-set on `status = 'scheduled'`). If a
 * future widening of that CAS breaks the argument, the test fails here rather than mislabelling
 * somebody's card.
 */
export function guestExitCauseForStatus(status: number): GuestExitCause {
  switch (status) {
    case 404:
      return 'removed';
    case 409:
      return 'host_ended';
    default:
      return 'access_ended';
  }
}
