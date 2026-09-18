'use server';

import 'server-only';

import { z } from 'zod';
import { log } from '@/lib/logging';
import { postLobbyReentryRequest } from '@/lib/meetings/join-api-client';
import {
  JOIN_UNAVAILABLE_TITLE,
  LOBBY_REENTRY_INVALID_INPUT_ERROR,
  LOBBY_REENTRY_NEUTRAL_MESSAGE,
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
 * ⚠ EVERY non-2xx status — `400`, `429`, `503`, and the transport sentinel `0` — maps to the
 * SAME `unavailable` literal. ⚠⚠ `429` IS **NOT** SPLIT OUT, deliberately: it fires
 * PRE-AUTHORIZATION, so a distinct message here would tell an anonymous scanner they are being
 * counted. (`poll-guest-admission.ts` splits `503` out for the GUEST POLL; that is safe only
 * because that path is reachable exclusively after a ≥256-bit token has already resolved,
 * which is not the case here.)
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
    return { success: false, kind: 'unavailable', error: JOIN_UNAVAILABLE_TITLE };
  }

  log.info('Lobby re-entry requested', { meetingId: parsed.data.meetingId });
  return { success: true, message: LOBBY_REENTRY_NEUTRAL_MESSAGE };
}
