'use server';

import 'server-only';

import { z } from 'zod';
import { log } from '@/lib/logging';
import { postLobbyReentryRequest } from '@/lib/meetings/join-api-client';
import {
  LOBBY_REENTRY_INVALID_INPUT_ERROR,
  LOBBY_REENTRY_NEUTRAL_MESSAGE,
  LOBBY_REENTRY_RETRY_LATER_ERROR,
  LOBBY_REENTRY_TRANSPORT_ERROR,
} from '@/lib/meetings/lobby';

/**
 * BAL-442 — a locked-out lobby visitor asks us to email a fresh link to the address ALREADY ON
 * THEIR ROW. They have no account BY DEFINITION, exactly as `claimLobbyPlaceAction` above.
 *
 * ⚠⚠ DELIBERATELY UNAUTHENTICATED, AND IT MUST NOT CALL `requireUser()` OR
 * `requireOnboardedUser()` — the same reasoning as `claimLobbyPlaceAction`'s docblock, verbatim:
 * the caller has no account, by definition. Passing `onboarding-mutation-gate.test.ts` is NOT
 * evidence of safety here — this module calls neither auth primitive, so it never enters that
 * scan's offending set either way. The paired assertion that makes the exemption deliberate
 * rather than accidental lives in `PUBLIC_ACTION_ALLOWLIST`
 * (`apps/web/src/invariants/_read-only-actions.ts`), which proves EXACT SET EQUALITY in both
 * directions: a new anonymous action fails CI until it is listed there, and deleting this
 * entry without deleting the file fails CI too. **This file is an entry on that list.**
 *
 * ⚠ IT LIVES UNDER `app/join/_actions/`, WHICH `join-link-never-writes.test.ts` EXCLUDES IN
 * ADVANCE — a POST-only Server Action here cannot be reached by a link scanner or a prefetch.
 *
 * ⚠ THE REAL AUTHORIZATION IS SERVER-SIDE AND ELSEWHERE: `apps/api`'s `requestLobbyReentryLink`
 * does the meeting resolution, the primary-context lookup, the live-pending-row match, the
 * mint/rotate and the four rate-limit windows — and its response is IDENTICAL, body, status
 * AND LATENCY, whether or not a row matched. The service returns `void`, so no verdict crosses
 * back into this layer to be leaked. This layer validates shape and forwards; it must not add a
 * second, chattier opinion.
 *
 * ⚠ IT IS THE ONLY ACTION ON `PUBLIC_ACTION_ALLOWLIST` THAT CAUSES AN EMAIL TO BE SENT, which
 * is why the api route behind it carries a FOURTH, RECIPIENT-KEYED rate-limit window the knock
 * does not — one bounding an INBOX rather than a caller.
 */

const reentrySchema = z.object({
  meetingId: z.string().uuid(),
  email: z.string().trim().email().max(254),
});

/**
 * ⚠⚠ THE `success: true` ARM CARRIES ONLY THE NEUTRAL MESSAGE — never a `matched` flag, never
 * a row id. That emptiness is deliberate: see `LobbyReentryState`'s docblock in
 * `@balo/shared/meetings`. The failure arm's `kind` discriminant mirrors
 * `ClaimLobbyPlaceResult`'s for the same reason: `invalid_input` is a fact about the caller's
 * OWN input (safe to be specific, keeps the panel open with the typed value intact);
 * `unavailable` is everything else, collapsed.
 */
export type RequestLobbyReentryLinkResult =
  | { success: true; message: string }
  | { success: false; kind: 'invalid_input' | 'unavailable'; error: string };

/**
 * ⚠⚠ CORRECTED BY THE FIX ROUND (R-2) — `JOIN_UNAVAILABLE_TITLE` IS NO LONGER RENDERED HERE.
 * This arm used to map `400` / `429` / `503` / the transport sentinel `0` all onto
 * "This link isn't active", which is FALSE for every one of them: the api answers `202` with
 * the neutral sentence for EVERY meeting-related outcome (its own docblock: "THERE IS NO `404`
 * AND NO `409` ON THIS ROUTE, EVER"), so nothing that reaches this branch says anything about a
 * meeting. `JOIN_UNAVAILABLE_TITLE` exists to protect MEETING ANONYMITY; with nothing to
 * protect, it only strands the guest — telling them to chase a fresh link from whoever shared
 * the meeting when the honest answer is "wait a minute and try again".
 *
 * ⚠⚠ `429` IS STILL NOT SPLIT OUT, and the original concern is still honoured: a `429`, a
 * `503` and a `400` all render the SAME {@link LOBBY_REENTRY_RETRY_LATER_ERROR}, so no wording
 * tells an anonymous scanner they are being counted. (`poll-guest-admission.ts` splits `503`
 * out for the GUEST POLL; that is safe only because that path is reachable exclusively after a
 * ≥256-bit token has already resolved, which is not the case here.) ⚠ DO NOT SPLIT BY STATUS.
 *
 * ⚠ THE TRANSPORT SENTINEL `0` IS THE ONE DISTINCTION, and it is a fact about the CALLER'S OWN
 * CONNECTION rather than about us: the request may never have arrived. It gets the same literal
 * the client component's `.catch()` arm renders for the identical condition, so one failure
 * mode cannot describe itself two ways depending on which layer noticed it.
 */
export async function requestLobbyReentryLinkAction(input: {
  meetingId: string;
  email: string;
}): Promise<RequestLobbyReentryLinkResult> {
  const parsed = reentrySchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      kind: 'invalid_input',
      error: LOBBY_REENTRY_INVALID_INPUT_ERROR,
    };
  }

  const result = await postLobbyReentryRequest(parsed.data.meetingId, parsed.data.email);

  if (!result.ok) {
    // ⚠ NO EMAIL ADDRESS IN THIS LOG — the meeting id and the api's fixed literal are the
    // actionable, safe fields (`claim-lobby-place.ts`'s rule verbatim).
    log.warn('Lobby re-entry refused', {
      meetingId: parsed.data.meetingId,
      status: result.status,
      code: result.code,
    });
    return {
      success: false,
      kind: 'unavailable',
      // ⚠ `0` IS THE TRANSPORT SENTINEL, never a status the server sent — see `JoinApiResult`.
      error: result.status === 0 ? LOBBY_REENTRY_TRANSPORT_ERROR : LOBBY_REENTRY_RETRY_LATER_ERROR,
    };
  }

  log.info('Lobby re-entry requested', { meetingId: parsed.data.meetingId });
  return { success: true, message: LOBBY_REENTRY_NEUTRAL_MESSAGE };
}
