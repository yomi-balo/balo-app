'use server';

import 'server-only';

import { z } from 'zod';
import { requireUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { getMeetingGuests } from '@/lib/meetings/guests-api-client';
import { GUEST_ACTION_COPY, guestActionCopyFor } from '@/lib/meetings/guests-copy';
import type { GetMeetingGuestsResult } from '@/lib/meetings/meeting-panels';

const inputSchema = z.object({ meetingId: z.uuid() });

/**
 * BAL-436 — read the party-scoped guest roster for the in-call People panel.
 *
 * ⚠⚠ **GENUINELY READ-ONLY, AND IT MUST STAY THAT WAY.** Bare `requireUser()` plus an entry
 * on `_read-only-actions.ts`'s `READ_ONLY_ALLOWLIST`: it forwards a `GET` and writes nothing,
 * anywhere, transitively. `onboarding-mutation-gate.test.ts` fails the build without that
 * entry, which is the mechanism that keeps this claim honest rather than aspirational.
 *
 * ⚠ THE GATE HERE IS A FIRST, CHEAP CHECK — NOT THE BOUNDARY. `apps/api`'s
 * `authorizeMeetingParticipation` is what actually decides, per meeting, and it re-verifies
 * the WorkOS token independently.
 *
 * ⚠⚠ `canHost` COMES BACK FROM THE SERVER AND IS PASSED THROUGH UNCHANGED. It is the
 * per-actor `hasEngagementCapability(HOST_MEETINGS)` verdict for this exact meeting, computed
 * behind the tenancy gate that must run first. **DO NOT re-derive it in this tier** even
 * though `apps/web/src/lib/authz/engagement.ts` now exists — a second resolution in the
 * browser tier would be a second expression of one rule, running WITHOUT
 * `authorizeMeetingParticipation` in front of it.
 *
 * ⚠ `retryable` IS PART OF THE CONTRACT. The panel's poll keeps its schedule on a transport
 * blip and stops on a verdict; collapsing the two makes a dropped packet look like a dead
 * meeting to a host mid-call.
 */
export async function getMeetingGuestsAction(input: {
  meetingId: string;
}): Promise<GetMeetingGuestsResult> {
  try {
    await requireUser();
  } catch {
    // ⚠ NO `log.error` HERE, DELIBERATELY, AND THIS IS THE ONE PLACE THAT DIFFERS FROM THE
    // THREE MUTATIONS. This action is POLLED — every ~10s while the panel is open — so an
    // expired session would write an error line per tick for the length of a call. The
    // signed-out state is not a defect and the panel surfaces it to the person immediately.
    return { success: false, error: GUEST_ACTION_COPY.unauthenticated, retryable: false };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Invalid request.', retryable: false };
  }
  const { meetingId } = parsed.data;

  const result = await getMeetingGuests(meetingId);
  if (!result.ok) {
    // ⚠ `warn`, NOT `error` — see the polling note above. Ids and codes only: never an
    // address, never a name, never a token.
    log.warn('Meeting guest roster read refused', {
      meetingId,
      status: result.status,
      code: result.code,
    });
    return {
      success: false,
      error: guestActionCopyFor(result),
      // ⚠ TRANSPORT (`0`), a rate limit and any 5xx are retryable; a `404` is a verdict.
      retryable: result.status === 0 || result.status === 429 || result.status >= 500,
    };
  }

  return {
    success: true,
    data: {
      guests: result.data.guests,
      canHost: result.data.canHost,
      participantCount: result.data.participantCount,
      participantCap: result.data.participantCap,
    },
  };
}
