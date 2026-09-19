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
 * `findLiveByTokenHash` stops resolving for FIVE reasons, not one, so the argument has to clear
 * each of them on the terminal transition of a call somebody was actually IN:
 *
 *   1. REVOKED — the case this maps to. `revoke` stamps `revoked_at` + `deleted_at` together.
 *   2. `denied` ADMISSION — a denied guest was never in the room.
 *   3. AN EXPIRED TOKEN — the TTL is `scheduled_end + 7 days`, so it cannot lapse mid-call.
 *   4. A SOFT-DELETED OR **CANCELLED** MEETING — a meeting cannot flip to `cancelled` once
 *      anybody has joined: both cancel writers compare-and-set on `status = 'scheduled'`.
 *   5. ⚠ **TOKEN ROTATION** — the one an earlier version of this list MISSED, and it is the only
 *      one that is not closed by an argument about state. Rotating replaces the stored hash, so
 *      the copy in the ejected person's browser 404s exactly as a revoked one does.
 *      `rotatePendingLobbyToken` cannot reach here (it matches `pending` rows only — never
 *      somebody who was in the room). `rotateToken`, behind `resendGuestJoinLink`, CAN in
 *      principle: its predicate is channel + `admission = 'admitted'`, NOT "has not arrived" —
 *      the has-not-arrived part is only where the panel offers the button. So a host who
 *      re-sends the link to a `link` guest who is already IN the call, and who then leaves that
 *      session, would read `removed`. Judged practically unreachable and left as a residual
 *      rather than a gate, because the fix belongs on the resend route (an arrival check), not
 *      on a card.
 *
 * ⚠ THE MISLABEL DIRECTION MATTERS: every one of these lands on `removed`, a wrong SPECIFIC
 * claim, rather than on `access_ended`. That is the failure rule 4 exists to prevent, which is
 * why the argument is written out rather than assumed. If a future widening of the cancel CAS —
 * or of `rotateToken`'s predicate — breaks it, the pinning test fails rather than a person being
 * told something false.
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
