'use server';

import 'server-only';

import { z } from 'zod';
import { requireOnboardedUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { removeMeetingGuest } from '@/lib/meetings/guests-api-client';
import { GUEST_ACTION_COPY, guestActionCopyFor } from '@/lib/meetings/guests-copy';
import type { RemoveGuestActionResult } from '@/lib/meetings/meeting-panels';

const inputSchema = z.object({ meetingId: z.uuid(), guestId: z.uuid() });

/**
 * BAL-476 (R3) — remove a guest from a meeting the actor is on.
 *
 * ⚠⚠ **REMOVE MEANS GONE NOW.** `apps/api`'s `removeGuest` revokes the credential (immediate and
 * total — every read path re-checks `revoked_at IS NULL`) and EJECTS the person from the live
 * Daily room with `ban: true` (R4). This action forwards one authenticated request and learns
 * only that it happened.
 *
 * ⚠⚠ THE GATE AND THE MESSAGES ARE BOTH **CHANNEL-DEPENDENT**, so neither can be stated flatly
 * here — `apps/api`'s `removalDenialReason` and `announceGuestRemoval` are where each rule lives:
 *
 *   · AN `email` ROW — SAME-PARTY membership, not `canHost` (R6 stands for that channel); and the
 *     person gets a removal email plus the `METHOD:CANCEL` that takes the event off their
 *     calendar.
 *   · A `link` ROW — `host_meetings` INSTEAD of same-party, because a lobby row's `party` is the
 *     writer's placeholder; and the person is told NOTHING, because the address on the row is
 *     self-declared and Balo never verified it. The confirm dialog has its own copy variant that
 *     promises neither (`use-guest-removal.tsx`).
 *
 * ⚠ EVERY REFUSAL, ON EITHER ARM, ANSWERS `guest_not_found` — identical on the wire to a
 * nonexistent id, so the route is an oracle for nothing. The panel's row-level visibility mirrors
 * the rule as a courtesy; it is never the enforcement.
 *
 * ⚠ NO `outcome` FIELD ON THE RESULT — see {@link RemoveGuestActionResult}. A lost race to a
 * concurrent removal answers the same plain `guest_not_found`, on purpose.
 *
 * ⚠ MUTATING ⇒ `requireOnboardedUser()`. ⚠ NO ADDRESS, NO NAME AND NO TOKEN IN ANY LOG LINE —
 * ids, the status and the code only.
 */
export async function removeGuestAction(input: {
  meetingId: string;
  guestId: string;
}): Promise<RemoveGuestActionResult> {
  try {
    await requireOnboardedUser();
  } catch (error) {
    log.error('Guest removal rejected — no onboarded session', {
      meetingId: typeof input.meetingId === 'string' ? input.meetingId : undefined,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: GUEST_ACTION_COPY.unauthenticated };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Invalid request.' };
  }
  const { meetingId, guestId } = parsed.data;

  const result = await removeMeetingGuest(meetingId, guestId);
  if (!result.ok) {
    log.error('Guest removal refused', {
      meetingId,
      guestId,
      status: result.status,
      code: result.code,
    });
    return { success: false, error: guestActionCopyFor(result) };
  }

  // ⚠ A CREDENTIAL WAS REVOKED. `apps/api` logs the authoritative line; this one records that
  // the in-call panel was the surface that asked for it, which is the funnel question.
  log.info('Guest removed from the in-call panel', { meetingId, guestId });
  return { success: true };
}
