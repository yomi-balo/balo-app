import {
  isMeetingReactionEmoji,
  MEETING_REACTIONS,
  type MeetingReactionEmoji,
} from '@balo/shared/meetings';

/**
 * BAL-437 — the in-call REACTION **wire payload** and its inbound guard.
 *
 * ⚠⚠ THE SIX-EMOJI VOCABULARY ITSELF LIVES IN `@balo/shared/meetings`, NOT HERE. It has two
 * consumers in two packages (`apps/web` and `@balo/analytics`, which cannot import `apps/web`),
 * so a copy in this file was a second definition of one closed set. This module re-exports it
 * verbatim — every existing import path keeps working — and adds the one thing that IS
 * web-specific: the Ably payload shape and its structural guard.
 *
 * ⚠ THE ONLY IMPORT IS `@balo/shared/meetings`, WHICH IS PURE (no `@balo/db`, no I/O, no
 * React). That matters because this module is reached from a `'use client'` island — a
 * transitive `@balo/db` import here would be the client-bundle footgun.
 *
 * ── ⚠⚠ IT IS A **CLOSED SERVER-VALIDATED SET**, AND THAT IS THE TRUST BOUNDARY ──────────
 *
 * The client's meeting-channel token is SUBSCRIBE-ONLY (ruling R2), so a reaction reaches the
 * wire only through `sendMeetingReactionAction`. If the emoji were a free string, that action
 * would be a "render arbitrary text over live video" endpoint. It is therefore enforced
 * TWICE, on two different tiers, for two different threats:
 *
 *   1. **On the way IN** — `z.enum(MEETING_REACTIONS)` in the action. Stops a crafted request
 *      body.
 *   2. **On the way OUT** — {@link isMeetingReactionPayload} on the inbound Ably payload,
 *      which arrives as `unknown` from a THIRD PARTY. Stops a compromised key or channel.
 *
 * Neither check is redundant: they defend opposite ends of the same pipe.
 */

export { isMeetingReactionEmoji, MEETING_REACTIONS };
export type { MeetingReactionEmoji };

/**
 * The Ably wire payload for `meeting:{meetingId}` → `reaction`.
 *
 * ⚠⚠ IT CARRIES **NO SENDER IDENTITY AT ALL**, and that is deliberate twice over: the design's
 * floaters are unattributed, and a payload with no identity cannot leak one. `nonce` is an
 * OPAQUE echo tag, not a user id and not a secret — see {@link isMeetingReactionPayload}.
 */
export interface MeetingReactionPayload {
  readonly emoji: MeetingReactionEmoji;
  /**
   * The sender's own opaque tag, echoed back by the server fan-out.
   *
   * ⚠⚠ ECHO SUPPRESSION KEYS ON **THIS**, NEVER ON USER IDENTITY. Because the SERVER publishes
   * (R2), the sender receives their own reaction back and would double-float it on top of the
   * optimistic render. Deduping by "is this me?" would need identity on the wire — which is
   * exactly what this shape refuses to carry. The client drops any inbound reaction whose
   * nonce it minted.
   */
  readonly nonce: string;
}

/**
 * STRUCTURAL guard over the inbound Ably payload.
 *
 * ⚠⚠ **EXACT SHAPE — AN EXTRA KEY IS A REJECTION.** The only legitimate publisher is
 * `sendMeetingReactionAction`, which emits exactly `{ emoji, nonce }`; anything wider did not
 * come from this platform. Strictness costs nothing (both sides ship together) and it removes
 * a whole class of "smuggle a field past the guard" question.
 *
 * ⚠ AN ARRAY IS AN OBJECT IN JavaScript, so the array case is checked explicitly. Without it
 * `['👍','x']` would fall through the `typeof === 'object'` test with `emoji`/`nonce`
 * undefined — harmless here only by accident, which is not a property worth relying on.
 */
export function isMeetingReactionPayload(data: unknown): data is MeetingReactionPayload {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return false;
  const keys = Object.keys(data);
  if (keys.length !== 2) return false;
  const record = data as Record<string, unknown>;
  return isMeetingReactionEmoji(record.emoji) && typeof record.nonce === 'string';
}
