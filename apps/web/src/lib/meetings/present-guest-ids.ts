import { parseDailyParticipantId } from '@balo/shared/meetings';

/**
 * BAL-436 — decode the LIVE Daily roster into the set of `meeting_guests.id` values that are
 * actually in the room right now.
 *
 * ── ⚠⚠ WHY THE LIVE ROSTER AND **NOT** `meeting_presence` ────────────────────────────────
 *
 * `meeting_presence` is a durable BILLING / OBSERVATION record — its own docblock calls it
 * "a MACHINE OBSERVATION", written by BAL-134's Daily webhooks with unavoidable lag, and it
 * has ZERO production writers today. The panel's question is not "who was here" but "is this
 * person in the room RIGHT NOW", which is the call object's own state: observed with no lag
 * and no round trip. Using a billing table to answer a liveness question would have been the
 * wrong coupling even after BAL-134 lands.
 *
 * ⚠ WRITTEN HAND-OFF TO BAL-134: when the presence writer ships it does NOT need to feed this
 * panel. If a future surface needs HISTORICAL presence, that is presence's job; liveness stays
 * on the call object.
 *
 * ── ⚠⚠ FAIL-CLOSED BY CONSTRUCTION ───────────────────────────────────────────────────────
 *
 * `parseDailyParticipantId` returns `null` — never a guess — for anything this platform did
 * not mint: a bare uuid, uppercase hex, an unknown tag, a vendor-generated id. An unrecognised
 * participant simply does not join the set, so it is IMPOSSIBLE for this function to report
 * somebody as present who is not. The consequence runs the safe way: an unrecognised guest is
 * rendered from their Daily `user_name` in "In the call" with no roster linkage, rather than
 * being silently matched to the wrong row.
 *
 * ⚠ `'u'`-TAGGED IDS ARE EXCLUDED. Those are `users.id` (a Balo member), and a member is not a
 * guest — the two ids are both uuids, which is the whole reason the encoding tags them apart.
 *
 * PURE: no I/O, no React, no vendor import. `@balo/shared/meetings` is dependency-free, so a
 * `'use client'` component may reach it without the `@balo/db` bundle footgun.
 */
export function presentGuestIdsFrom(userIds: readonly string[]): Set<string> {
  const present = new Set<string>();
  for (const userId of userIds) {
    const guestId = guestIdFromParticipantClaim(userId);
    if (guestId !== null) present.add(guestId);
  }
  return present;
}

/**
 * The SINGLE-participant form of the above: one Daily `user_id` claim → the
 * `meeting_guests.id` it names, or `null`.
 *
 * ⚠⚠ IT EXISTS BECAUSE THE PANEL NEEDS THE **MAPPING**, NOT JUST THE SET. "In the call"
 * renders one row per LIVE participant, and a `link`-channel guest's row must carry the
 * UNVERIFIED badge there exactly as it does in the queue — the badge's only input is
 * `inviteChannel === 'link'`, which is INDEPENDENT of presence and of `party`. Answering that
 * from a `Set<string>` alone is impossible: the set says "somebody is present", not "THIS tile
 * is that roster row". Deriving the badge from the set was how it silently vanished the moment
 * a stranger actually walked in — i.e. at precisely the moment it mattered most.
 *
 * ⚠ FAIL-CLOSED, identically: `null` for anything this platform did not mint, and `null` for a
 * `'u'`-tagged member id. A caller that gets `null` renders the participant from their Daily
 * `user_name` with no roster linkage and no row action, which is the safe direction.
 */
export function guestIdFromParticipantClaim(userId: string | null): string | null {
  if (userId === null) return null;
  const identity = parseDailyParticipantId(userId);
  if (identity === null || identity.kind !== 'guest') return null;
  return identity.id;
}
