/**
 * BAL-129 (ADR-1044/ADR-1045) — THE DAILY ROOM NAME, derived from `meetings.id`.
 *
 * ⚠⚠ THIS FUNCTION IS LOAD-BEARING, NOT COSMETIC. It is a TOTAL, INJECTIVE function of the
 * meeting's primary key, and four things in BAL-129 rest on that and on nothing else:
 *
 *   1. TWO MEETINGS CAN NEVER COLLIDE. Distinct uuids ⇒ distinct names, mechanically. The
 *      partial unique `meeting_daily_room_name_idx` is a backstop that can never fire for
 *      two distinct live meetings.
 *   2. IDEMPOTENCY NEEDS NO ARBITER BEYOND THE NAME. Two concurrent `provisionMeeting(M)`
 *      calls derive the SAME name, so the loser's `POST /v1/rooms` is a `400 already-exists`
 *      that resolves — via a `GET` — to the SAME room, and both `setVenue` writes are
 *      byte-identical `UPDATE`s on one row. That is why this ticket writes no `ON CONFLICT`
 *      clause anywhere and needs no conditional write.
 *   3. NO ROOM CAN BE STRANDED BY THE CONCURRENT RACE. A room created for meeting M can only
 *      ever be claimed by M, so two racing `provisionMeeting(M)` calls cannot leave a second,
 *      unclaimable room behind: the loser's create is a `400 already-exists` that resolves —
 *      via a `GET` — to the FIRST racer's room. That is the exact and ONLY scope of the claim.
 *      ⚠ IT IS NOT "orphan rooms cannot exist". Two live paths do strand a room at the
 *      vendor, and BAL-129 accepts both rather than fixing them — see
 *      `services/meetings/provision-meeting.ts`'s module docblock, which names them and their
 *      owners (BAL-400 for the repair path, BAL-410 for cancel-time deletion). Rooms are
 *      created with no `exp`, so a stranded room persists indefinitely. What (3) buys is that
 *      such a room is always addressable BY ITS MEETING — `provisionMeeting(M)` re-derives
 *      the same name and adopts it — which is what makes those follow-ups cheap, not
 *      unnecessary.
 *   4. IT IS ONLY SAFE BECAUSE ROOMS ARE PRIVATE. Anyone who learns a `meetings.id` can
 *      compute this name and therefore the `daily.co` URL. Knowing the URL buys NOTHING
 *      without a token, because `services/daily/rooms.ts` creates every room
 *      `privacy: 'private'`. Derivability is acceptable ONLY under that guarantee — see D8.
 *
 * ⚠ IF ANYONE EVER MAKES THIS NAME RANDOM, SALTED OR SUFFIXED, all four collapse at once: the
 * no-`ON CONFLICT`, no-room-stranded-by-the-RACE, no-conditional-write reasoning in
 * `services/meetings/provision-meeting.ts` stops holding. The format is PINNED by
 * `room-name.test.ts` precisely so that change cannot be made quietly.
 *   ⚠ NOTE THE PHRASING. It is NOT "no-orphan-room" — that is the overclaim (3) above spends
 *   half its length retracting, and repeating it here would reinstate it two paragraphs later.
 *   Three live paths DO strand a room; see `provision-meeting.ts`.
 *
 * It lives in `@balo/shared/meetings` — not in `apps/api` — so BAL-131's webhook resolver
 * (`meetingsRepository.findByDailyRoomName`) and BAL-132's token minter share ONE
 * definition, and so an `apps/web` join surface can derive it without value-importing
 * `@balo/db` (the client-bundle footgun). PURE and dependency-free.
 */

/**
 * `balo-` + the meeting uuid's 32 lowercase hex digits — 37 characters matching
 * `^balo-[0-9a-f]{32}$`, inside Daily's 41-character limit and its `[A-Za-z0-9_-]`
 * alphabet.
 */
export function dailyRoomNameForMeeting(meetingId: string): string {
  return `balo-${meetingId.replace(/-/g, '').toLowerCase()}`;
}
