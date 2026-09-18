'use server';

import 'server-only';

import { z } from 'zod';
import { log } from '@/lib/logging';
import { guestExitCauseForStatus, type GuestExitCause } from '@/lib/meetings/guest-exit-cause';
import { postGuestJoinProbe } from '@/lib/meetings/join-api-client';
import { GUEST_EXIT_PROBE_TIMEOUT_MS } from '@/lib/meetings/lobby';

/**
 * BAL-476 (R5 amended) — "why am I out of this call?", asked of the SERVER on the terminal
 * ejection transition.
 *
 * ⚠⚠ DELIBERATELY UNAUTHENTICATED, AND IT IS **NOT** A NEW AUTHENTICATED SURFACE FOR SOMEBODY WE
 * JUST DE-AUTHENTICATED. A guest has no Balo session at all — the token IS the credential — and
 * `POST /meetings/:id/guest-join` is public by design. A just-revoked guest can still REACH it;
 * what changed is not their ability to ask but the ANSWER they get. This action reads the refusal
 * their dead credential now produces, which the codebase already classifies. It is therefore the
 * THIRD member of the same anonymous-guest family as `claim-lobby-place` and
 * `poll-guest-admission`, and it is on `PUBLIC_ACTION_ALLOWLIST` for that reason.
 *
 * ⚠ IT PERFORMS NO WRITE, ANYWHERE. `probe: true` short-circuits the api service before the
 * admission switch: no Daily token minted, no `guest_joined` analytics, no row touched.
 *
 * ⚠⚠ IT NEVER THROWS. A rejection here would land the ejected person in a Next error boundary
 * instead of a card — the exact opposite of the point. Every failure resolves to `access_ended`,
 * the VAGUER card, through {@link guestExitCauseForStatus}'s default arm.
 *
 * ⚠ ONE ATTEMPT, HARD-BOUNDED. No poll, no back-off, no re-arm — this is a terminal transition,
 * not a wait, and the card it selects offers no retry affordance at all.
 *
 * ⚠ NO TOKEN (not even a prefix), NO EMAIL, NO NAME IN ANY LOG LINE.
 */

const inputSchema = z.object({
  meetingId: z.uuid(),
  guestToken: z.string().min(20).max(200),
});

export async function resolveGuestExitReasonAction(input: {
  meetingId: string;
  guestToken: string;
}): Promise<GuestExitCause> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    // We cannot ask, so we do not claim. The vaguer card is the honest answer.
    return 'access_ended';
  }

  try {
    const result = await postGuestJoinProbe(
      parsed.data.meetingId,
      parsed.data.guestToken,
      AbortSignal.timeout(GUEST_EXIT_PROBE_TIMEOUT_MS)
    );
    if (result.ok) {
      // A live meeting AND a live token, on a transition that says otherwise: genuinely
      // inconclusive (most likely the ejection has not reached Postgres yet, or this is a
      // different cause entirely). Say less, not something false.
      return 'access_ended';
    }
    log.warn('Guest exit-reason probe refused', {
      meetingId: parsed.data.meetingId,
      status: result.status,
    });
    return guestExitCauseForStatus(result.status);
  } catch (error) {
    log.warn('Guest exit-reason probe failed', {
      meetingId: parsed.data.meetingId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'access_ended';
  }
}
