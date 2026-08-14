'use server';

import 'server-only';

import { z } from 'zod';
import { requireOnboardedUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { decideMeetingGuestAdmission } from '@/lib/meetings/guests-api-client';
import { GUEST_ACTION_COPY, guestActionCopyFor } from '@/lib/meetings/guests-copy';
import type { DecideAdmissionActionResult } from '@/lib/meetings/meeting-panels';

const inputSchema = z.object({
  meetingId: z.uuid(),
  guestId: z.uuid(),
  decision: z.enum(['admit', 'deny']),
});

/**
 * BAL-436 — a host admits or denies somebody waiting in the meeting's lobby queue.
 *
 * ⚠⚠ **THE UI GATE IS NOT THE GATE.** The panel renders these controls only when the guests
 * GET answered `canHost: true`, and `apps/api` re-checks
 * `hasEngagementCapability(HOST_MEETINGS)` behind the tenancy gate on every call. A non-host
 * who reached this action gets `404 meeting_not_found`, collapsed and indistinguishable from
 * a meeting that does not exist — the surface has no 403 anywhere.
 *
 * ⚠⚠ `409 guest_not_pending` IS A **RACE OUTCOME, NOT AN ERROR.** Two hosts of one meeting can
 * both see the same knock; the compare-and-set in the repository means exactly one decision is
 * recorded. The loser's answer is "someone else already decided this", which the panel renders
 * as an INFORMATIONAL toast plus a refetch, never as a failure — the outcome the host wanted
 * has happened either way. `outcome: 'already_decided'` is what carries that distinction into
 * analytics without the panel string-matching prose.
 *
 * ⚠ A DENY IS NEVER REFUSED FOR CAPACITY, and that is the api's rule rather than this layer's:
 * denying is the host's only control for clearing a flooded queue, so gating it on a full room
 * would jam the one lever that unjams the meeting.
 *
 * ⚠ NO EMAIL ADDRESS, NO GUEST NAME AND NO SELF-DECLARED STRING REACHES A LOG LINE HERE. A
 * `link`-channel row's name is typed by an anonymous visitor; ids and the decision only.
 */
export async function decideGuestAdmissionAction(input: {
  meetingId: string;
  guestId: string;
  decision: 'admit' | 'deny';
}): Promise<DecideAdmissionActionResult> {
  try {
    await requireOnboardedUser();
  } catch (error) {
    log.error('Guest admission decision rejected — no onboarded session', {
      meetingId: typeof input.meetingId === 'string' ? input.meetingId : undefined,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: GUEST_ACTION_COPY.unauthenticated, outcome: 'failed' };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Invalid request.', outcome: 'failed' };
  }
  const { meetingId, guestId, decision } = parsed.data;

  const result = await decideMeetingGuestAdmission(meetingId, guestId, decision);
  if (!result.ok) {
    const alreadyDecided = result.code === 'guest_not_pending';
    // ⚠ `warn` FOR THE RACE, `error` FOR A REAL REFUSAL. A second host winning the race is
    // normal operation on a two-host call, and logging it at error level would train whoever
    // reads Axiom to ignore this line.
    const line = 'Guest admission decision refused';
    const context = { meetingId, guestId, decision, status: result.status, code: result.code };
    if (alreadyDecided) {
      log.warn(line, context);
    } else {
      log.error(line, context);
    }
    return {
      success: false,
      error: guestActionCopyFor(result),
      outcome: alreadyDecided ? 'already_decided' : 'failed',
    };
  }

  log.info('Guest admission decided from the in-call panel', { meetingId, guestId, decision });
  return { success: true };
}
