'use server';

import 'server-only';

import { z } from 'zod';
import { requireUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { getMeetingState } from '@/lib/meetings/meeting-lifecycle-client';
import type { GetMeetingStateResult, MeetingStateWire } from '@/lib/meetings/meeting-state';

/**
 * BAL-134 (§7.1) — read one meeting's live state for the in-call mirror.
 *
 * ⚠⚠ **THIS MODULE EXPORTS EXACTLY ONE ASYNC FUNCTION AND NOTHING ELSE.** A `'use server'`
 * file may export ONLY async functions: an `export const` of any non-function value here fails
 * `next build` with "A 'use server' file can only export async functions" while `tsc --noEmit`,
 * eslint AND vitest all pass (memory `reference_use_server_no_value_exports`). The cadence
 * constants live in `use-meeting-state-poll.ts` and the shapes live in `meeting-state.ts`
 * precisely so that rule is never tested.
 *
 * ⚠⚠ **GENUINELY READ-ONLY, AND IT MUST STAY THAT WAY.** Bare `requireUser()` plus an entry on
 * `_read-only-actions.ts`'s `READ_ONLY_ALLOWLIST`: it forwards a `GET` and writes nothing,
 * anywhere, transitively. `onboarding-mutation-gate.test.ts` fails the build without that
 * entry, which is the mechanism that keeps this claim honest rather than aspirational. Its
 * sibling `end-meeting.ts` is a MUTATION and uses `requireOnboardedUser()` — do not copy this
 * gate across to it.
 *
 * ⚠ THE GATE HERE IS A FIRST, CHEAP CHECK — NOT THE BOUNDARY. `apps/api`'s
 * `authorizeMeetingParticipation` is what actually decides, per meeting, and it re-verifies the
 * WorkOS token independently. Every denial there collapses to `404`.
 *
 * ⚠ NO `log.error` ON THE UNAUTHENTICATED ARM, DELIBERATELY — the same reasoning as
 * `get-meeting-guests.ts`. This action is POLLED (every ~10s for the length of a call), so an
 * expired session would write one error line per tick.
 */

const inputSchema = z.object({ meetingId: z.uuid() });

export async function getMeetingStateAction(input: {
  meetingId: string;
}): Promise<GetMeetingStateResult> {
  try {
    await requireUser();
  } catch {
    return { success: false, retryable: false };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, retryable: false };
  }
  const { meetingId } = parsed.data;

  const result = await getMeetingState(meetingId);
  if (!result.ok) {
    // ⚠ `warn`, NOT `error` — see the polling note above. Ids and codes only.
    log.warn('Meeting state read refused', {
      meetingId,
      status: result.status,
      code: result.code,
    });
    return {
      success: false,
      // ⚠ TRANSPORT (`0`), a rate limit and any 5xx are retryable; a `404` is a verdict and the
      // poll must stop rather than spend eight lives confirming an answer it already has.
      retryable: result.status === 0 || result.status === 429 || result.status >= 500,
      ...(result.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: result.retryAfterSeconds }),
    };
  }

  // ⚠ THE BODY IS FORWARDED UNVALIDATED AND **PARSED IN THE BROWSER** by `parseMeetingState`.
  // Validating here would mean two definitions of the shape, on both sides of one hop; the
  // consumer that must degrade gracefully is the one that should own the parse.
  return { success: true, state: result.data as MeetingStateWire };
}
