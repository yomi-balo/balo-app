'use server';

import 'server-only';

import { z } from 'zod';
import { log } from '@/lib/logging';
import { postLobbyClaim } from '@/lib/meetings/join-api-client';
import { JOIN_UNAVAILABLE_TITLE } from '@/lib/meetings/lobby';

/**
 * BAL-132 — an ANONYMOUS visitor claims a place in a meeting's admission queue.
 *
 * ⚠⚠ DELIBERATELY UNAUTHENTICATED, AND IT MUST NOT CALL `requireOnboardedUser()`. That gate
 * is the rule for mutating Server Actions (`onboarding-mutation-gate.test.ts`), and this is
 * the deliberate exception: **the caller has no account, by definition** — that is the entire
 * premise of a waiting-to-join queue for someone who was forwarded a link.
 *
 * ⚠ HOW IT SITS WITH THAT INVARIANT — AND IT IS **NOT** "no entry needed", WHICH IS WHAT AN
 * EARLIER VERSION OF THIS DOCBLOCK CLAIMED ("IT PASSES THAT INVARIANT WITHOUT AN EXCLUSION
 * ENTRY … VERIFIED"). That was true of the ORIGINAL test and is no longer true of the file:
 *   · The `bareRequireUser` scan looks for `'use server'` modules calling BARE `requireUser(`.
 *     This module calls NEITHER `requireUser` NOR `requireOnboardedUser`, so it never enters
 *     that offending set — and passing that way was never EVIDENCE OF SAFETY. It is exactly
 *     what a THIRD, accidentally-unauthenticated mutating action would also do.
 *   · So the invariant gained a second, opposite assertion: `PUBLIC_ACTION_ALLOWLIST` in
 *     `invariants/_read-only-actions.ts` names every `'use server'` module under `app/join/`
 *     that references no auth or session primitive at all, and the test proves EXACT SET
 *     EQUALITY in both directions. **This file is an entry on that list.** A new anonymous
 *     action fails CI; deleting this entry without deleting the file fails CI too.
 * An entry there asserts that the authorization is SERVER-SIDE AND ELSEWHERE, and names where
 * — not that none is needed. Nothing was weakened to make room for it.
 *
 * ⚠ AND IT LIVES UNDER `app/join/_actions/`, WHICH `join-link-never-writes.test.ts` EXCLUDES
 * IN ADVANCE — that invariant's docblock names this exact ticket: BAL-132's lobby "must
 * arrive as a POST-only Server Action here (or an `apps/api` route)". A POST-only action is
 * what this is; a link scanner or a prefetch cannot reach it.
 *
 * ⚠ THE REAL AUTHORIZATION IS SERVER-SIDE AND ELSEWHERE. This action validates shape and
 * forwards; `apps/api`'s `claimLobbyPlace` does the meeting resolution, the liveness check,
 * the participant cap and the rate limiting — and collapses EVERY failure into one literal
 * for anonymity. This layer must not add a second, chattier opinion.
 */

const claimSchema = z.object({
  meetingId: z.string().uuid(),
  name: z.string().trim().min(1).max(160),
  email: z.string().trim().email().max(254),
});

/**
 * ⚠⚠ THE FAILURE ARM CARRIES A `kind` DISCRIMINANT, AND THAT IS NOT COSMETIC.
 *
 * Without it the UI could not tell "you typed something we cannot use" from "this link is
 * dead", so it treated BOTH as terminal — destroying the visitor's typed name and email and
 * stranding them on a dead-end card. **AND THE VALIDATION ARM IS REACHABLE IN NORMAL USE**: the
 * browser's own `required` accepts a whitespace-only name and `type="email"` accepts `a@b`, and
 * Zod rejects both. So a real person typing a real thing hit the dead-link card.
 *
 *   · `invalid_input` — a fact about the CALLER'S OWN INPUT. Discloses nothing about any
 *     meeting, so it is safe to be specific, and the form must stay on screen with the values
 *     intact.
 *   · `unavailable`   — everything else, collapsed. Terminal.
 */
export type ClaimLobbyPlaceResult =
  | { success: true; lobbyToken: string }
  | { success: false; kind: 'invalid_input' | 'unavailable'; error: string };

/**
 * ⚠⚠ EVERY **SERVER** FAILURE RETURNS THE SAME STRING. Not "that meeting was cancelled", not
 * "the room is full", not "you were denied" — the api already refuses to tell us which, and
 * this layer must not invent a distinction it does not have. See `JOIN_UNAVAILABLE_TITLE`.
 *
 * The ONE exception is a malformed form submission, which is a fact about the caller's own
 * input and reveals nothing about any meeting.
 *
 * ⚠ A `429` IS **NOT** SPLIT OUT HERE, deliberately. It fires pre-authorization, so a distinct
 * message would tell an anonymous scanner they are being counted. (The guest POLL does split
 * `503` out — see `poll-guest-admission.ts` for exactly why that one is safe and this is not.)
 */
export async function claimLobbyPlaceAction(input: {
  meetingId: string;
  name: string;
  email: string;
}): Promise<ClaimLobbyPlaceResult> {
  const parsed = claimSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      kind: 'invalid_input',
      error: 'Please enter your name and a valid email address.',
    };
  }

  const result = await postLobbyClaim(parsed.data.meetingId, parsed.data.name, parsed.data.email);

  if (!result.ok) {
    // ⚠ NO EMAIL ADDRESS IN THIS LOG. The meeting id and the api's fixed literal are the
    // actionable, safe fields.
    log.warn('Lobby claim refused', {
      meetingId: parsed.data.meetingId,
      status: result.status,
      code: result.code,
    });
    return { success: false, kind: 'unavailable', error: JOIN_UNAVAILABLE_TITLE };
  }

  log.info('Lobby place claimed', { meetingId: parsed.data.meetingId });
  // ⚠ The raw token goes back to the browser that just created it, and to nowhere else. It is
  // the bearer's own credential — see `claimLobbyPlace`'s docblock in `apps/api`.
  return { success: true, lobbyToken: result.data.lobbyToken };
}
