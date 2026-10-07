'use server';

import 'server-only';

import { z } from 'zod';
import { requireOnboardedUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { vouchMeetingGuest } from '@/lib/meetings/guests-api-client';
import {
  GUEST_ACTION_COPY,
  GUEST_ACTION_INVALID_REQUEST,
  GUEST_ACTION_UNAUTHENTICATED,
  guestActionCopyFor,
} from '@/lib/meetings/guests-copy';
import type { VouchActionResult } from '@/lib/meetings/meeting-panels';

const inputSchema = z.object({
  meetingId: z.uuid(),
  guestId: z.uuid(),
  email: z.string().trim().pipe(z.email()),
});

/**
 * BAL-579 — a client member vouches for somebody who knocked through the meeting link, naming
 * their work email. The api rewrites the row as a client-party `email` guest and, for somebody
 * already in the call, starts the time-together clock.
 *
 * ⚠⚠ **THE UI GATE IS NOT THE GATE.** The panel offers Vouch only when the guests GET answered
 * `canVouch: true`; `apps/api` re-checks the client-side tenancy gate and refuses the delivering
 * expert on every call, answering one collapsed `guest_not_found` for every refusal.
 *
 * ⚠⚠ THE TYPED ADDRESS IS NEVER LOGGED — not on success, not on refusal. Ids, the status and the
 * code only. `409 guest_already_invited` (that address already holds a seat) and
 * `404 guest_not_found` (a lost race or a refusal) are expected outcomes, so they log at `warn`.
 */
export async function vouchGuestAction(input: {
  meetingId: string;
  guestId: string;
  email: string;
}): Promise<VouchActionResult> {
  try {
    await requireOnboardedUser();
  } catch (error) {
    log.error('Guest vouch rejected — no onboarded session', {
      meetingId: typeof input.meetingId === 'string' ? input.meetingId : undefined,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return {
      success: false,
      error: GUEST_ACTION_COPY.unauthenticated,
      ...GUEST_ACTION_UNAUTHENTICATED,
    };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: 'Enter a valid work email address.',
      ...GUEST_ACTION_INVALID_REQUEST,
    };
  }
  const { meetingId, guestId, email } = parsed.data;

  const result = await vouchMeetingGuest(meetingId, guestId, email);
  if (!result.ok) {
    const expected = result.code === 'guest_not_found' || result.code === 'guest_already_invited';
    const line = 'Guest vouch refused';
    const context = { meetingId, guestId, status: result.status, code: result.code };
    if (expected) {
      log.warn(line, context);
    } else {
      log.error(line, context);
    }
    return {
      success: false,
      error: guestActionCopyFor(result),
      status: result.status,
      code: result.code,
    };
  }

  log.info('Guest vouched from the in-call panel', {
    meetingId,
    guestId,
    admission: result.data.admission,
  });
  return { success: true };
}
