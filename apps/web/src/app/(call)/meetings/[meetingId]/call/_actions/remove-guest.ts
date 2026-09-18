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
 * BAL-476 (R3) — a party member removes a guest their own side invited.
 *
 * ⚠⚠ **REMOVE MEANS GONE NOW.** `apps/api`'s `removeGuest` revokes the credential (immediate and
 * total — every read path re-checks `revoked_at IS NULL`), EJECTS the person from the live Daily
 * room with `ban: true` (R4), emails them, and publishes the `METHOD:CANCEL` that takes the event
 * off their calendar. This action forwards one authenticated request and learns only that it
 * happened.
 *
 * ⚠ THE GATE IS SAME-PARTY MEMBERSHIP, NOT `canHost` — deliberately, and it is the SHIPPED route
 * rule (R6): a cross-party attempt answers `guest_not_found`, identical on the wire to a
 * nonexistent id. The panel's row-level visibility mirrors that rule as a courtesy; it is never
 * the enforcement.
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
