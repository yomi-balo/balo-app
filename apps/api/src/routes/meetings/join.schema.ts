import { z } from 'zod';
import { sanitizeSelfDeclaredName } from '@balo/shared/meetings';

/**
 * BAL-132 — the Zod boundary for the three join routes.
 *
 * ⚠⚠ THERE IS DELIBERATELY NO `party` KEY, NO `accessScope` KEY AND NO `isOwner` KEY, and
 * their absence is the security property rather than an omission — the identical rule
 * `guests.schema.ts` records, extended to the two things this ticket adds:
 *   · `party` is a PLACEHOLDER the server writes on a lobby knock (`client`), because a bare
 *     meeting URL carries no sharer identity. A body field would let a visitor declare
 *     themselves expert-side and appear in the host's queue as the counterparty's colleague.
 *   · `accessScope` is server-computed and stored as the record of a grant. A body field
 *     would let an anonymous caller award themselves a whole retrospective engagement
 *     envelope.
 *   · `isOwner` is the `hasEngagementCapability(HOST_MEETINGS)` verdict. A body field would
 *     be self-service Daily owner rights — mute anyone, end the call.
 *
 * Zod's default object behaviour STRIPS unknown keys, so a caller that sends any of them is
 * silently ignored rather than honoured — which is the correct outcome. ⚠ DO NOT weaken any
 * of these to `.passthrough()`; that stripping is what makes the guarantee structural.
 */

/** `:meetingId` — all three routes. */
export const meetingIdParamsSchema = z.object({
  meetingId: z.string().uuid(),
});

export type MeetingIdParams = z.infer<typeof meetingIdParamsSchema>;

/**
 * The anonymous lobby knock.
 *
 * ⚠ BOTH FIELDS ARE REQUIRED, AND `email` IS LOAD-BEARING RATHER THAN COSMETIC.
 * `meeting_guests.email` is NOT NULL, and the partial unique index
 * `meeting_guest_meeting_email_live_idx` on `(meeting_id, party, email)` is the ONLY thing
 * bounding one visitor from spamming N pending rows into a host's queue. Making it optional
 * would remove that bound entirely. `name` is what the host actually reads in the queue.
 */
export const lobbyClaimBodySchema = z.object({
  /**
   * ⚠⚠ **SANITISED AT THE BOUNDARY, BEFORE THE ROW IS WRITTEN.** BAL-436's concealment is
   * FIELD-SCOPED: `projectGuestForViewer`'s `link` arm removes `email`, `emailDomain` and
   * `accessScope`, and refuses to fall `displayName` back to the address — but the very next
   * column, `name`, is typed by the same anonymous visitor and IS shown to the host, inside
   * the queue row, inside the `Admit …` / `Deny …` accessible names, and (on a re-send) inside
   * a Balo-branded email. A knock as `"dana.okoro@northwind.com"` or
   * `"Dana Okoro ✅ Verified"` therefore defeats the concealment through the neighbouring
   * column, and Ruling B's own argument against showing the address — that it MANUFACTURES
   * confidence rather than raising it honestly — applies to that string word for word.
   *
   * ⚠ IT COLLAPSES, IT DOES NOT REJECT. A `400` would tell an anonymous caller which strings
   * the server dislikes and would strand somebody whose real problem is a typo;
   * `sanitizeSelfDeclaredName` yields `Guest`, which is exactly what the projector already
   * shows for a `link` row with no name. ⚠ THE TRANSFORM RUNS **AFTER** `min(1)`, so an empty
   * knock is still a `400` — the collapse is not a way to send nothing.
   *
   * ⚠ WHAT IT DOES NOT COVER is stated in `sanitizeSelfDeclaredName`'s docblock and is NOT
   * pretended away here: an arbitrary organisational claim ("(Northwind IT)") or a homoglyph
   * still gets through. The UNVERIFIED badge and the queue disclosure are the answer to those.
   */
  name: z.string().trim().min(1).max(160).transform(sanitizeSelfDeclaredName),
  /** ⚠ 254 IS THE RFC 5321 MAXIMUM for a whole address path — matching `guests.schema.ts`. */
  email: z.string().trim().email().max(254),
});

export type LobbyClaimBody = z.infer<typeof lobbyClaimBodySchema>;

/**
 * The guest mint / poll.
 *
 * ⚠ THE TOKEN TRAVELS IN THE **BODY**, NEVER IN THE URL OR A QUERY PARAMETER. URLs land in
 * access logs, proxy logs and `Referer` headers; a guest token is deliberately NOT single-use
 * and stays replayable for its whole window, so one logged copy is a live credential rather
 * than a spent one. This is also why the route is a POST for what is arguably a read.
 *
 * The bounds are deliberately loose (20..200): the shipped mint is 43 base64url characters,
 * but pinning the exact length here would turn a future token-format change into a 400 on
 * every existing link, and the real validation is the hash lookup.
 */
export const guestJoinBodySchema = z.object({
  guestToken: z.string().min(20).max(200),
});

export type GuestJoinBody = z.infer<typeof guestJoinBodySchema>;
