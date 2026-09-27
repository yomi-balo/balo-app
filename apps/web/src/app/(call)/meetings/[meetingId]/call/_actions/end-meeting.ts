'use server';

import 'server-only';

import { z } from 'zod';
import { MEETING_END_NOT_JOINED_CODE, MEETING_END_NOT_STARTED_CODE } from '@balo/shared/meetings';
import { requireOnboardedUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { endMeeting } from '@/lib/meetings/meeting-lifecycle-client';
import {
  END_MEETING_FAILED_COPY,
  END_MEETING_NOT_JOINED_COPY,
  END_MEETING_NOT_STARTED_COPY,
  type EndMeetingResult,
} from '@/lib/meetings/meeting-state';

/**
 * BAL-134 / ADR-1049 (§5.4) — **END THE MEETING FOR EVERYONE. THE SERVER IS THE AUTHORITY.**
 *
 * ⚠⚠ IT REPLACES A CLIENT-SIDE EJECT THAT REVOKED NOTHING. BAL-435 shipped "End for everyone"
 * as `daily.updateParticipants({ '*': { eject: true } })`; per the `daily-co` skill's own trap
 * list an eject does NOT revoke a token, and Balo's tokens carry `eject_at_token_exp: false`
 * with `exp` at scheduled end + 24h — so every ejected participant could rejoin immediately.
 * `POST /meetings/:meetingId/end` closes the presence intervals, writes `status='ended'` with
 * `ended_at` and `ended_by` in ONE transaction, and deletes the Daily room. The client keeps
 * its local teardown only for responsiveness; this call is what makes the meeting over.
 *
 * ⚠⚠ **THIS MODULE EXPORTS EXACTLY ONE ASYNC FUNCTION.** A `'use server'` file may export ONLY
 * async functions — an `export const` here fails `next build` while tsc, eslint and vitest all
 * pass (memory `reference_use_server_no_value_exports`). `END_MEETING_FAILED_COPY` and
 * `END_MEETING_NOT_JOINED_COPY` and `END_MEETING_NOT_STARTED_COPY` therefore live in `meeting-state.ts`, not here.
 *
 * ⚠ A MUTATION, SO `requireOnboardedUser()` — NOT the bare `requireUser()` its read-only
 * sibling `get-meeting-state.ts` uses. `onboarding-mutation-gate.test.ts` enforces exactly
 * this split, and this action must never join `READ_ONLY_ALLOWLIST`.
 *
 * ⚠⚠ **THE UI GATE IS NOT THE GATE.** The End control renders only when the grant's
 * `canEndMeeting` is true, and `apps/api` re-resolves BOTH authority axes — the engagement
 * `host_meetings` capability and the client company's `CONSUME_CREDITS` membership token —
 * behind the tenancy gate on every call. A browser that flips the boolean gains nothing: it
 * gets `404 meeting_not_found`, collapsed and indistinguishable from a meeting that does not
 * exist, because there is no 403 anywhere on `/meetings/*`.
 *
 * ⚠⚠ `alreadyEnded` IS A **SUCCESS** (D10). Two holders can press End in the same instant; the
 * server transition is a compare-and-set and the loser gets `200 { alreadyEnded: true }` with
 * no second teardown, no second audit row and no second analytics event. Reporting that as a
 * failure would put a red toast on a race that resolved exactly as intended.
 *
 * ⚠⚠ `meeting_not_joined` AND `meeting_not_started` ARE THE TWO REFUSALS WITH THEIR OWN COPY (BAL-474). The
 * second (R6-C6) is an End pressed before the scheduled start. The first (D6.4): a CLIENT
 * principal who has no presence row of their own in the meeting cannot End it — otherwise a
 * member who never joined could turn the expert's wait into a free cancellation after the start.
 * End renders only in the joined call, so the only way a person reaches it is the lag between
 * joining Daily and the presence row landing (a webhook that usually takes seconds; the
 * lifecycle sweep reconciles the roster every minute). That is an EXPECTED race, not a defect:
 * it is logged at `info`, and the toast says the call is still running and to try again shortly.
 * An already-ended meeting never reaches it — that is the idempotent success above (D8.7).
 */

const inputSchema = z.object({ meetingId: z.uuid() });

export async function endMeetingAction(input: { meetingId: string }): Promise<EndMeetingResult> {
  try {
    await requireOnboardedUser();
  } catch (error) {
    log.error('Meeting end rejected — no onboarded session', {
      meetingId: typeof input.meetingId === 'string' ? input.meetingId : undefined,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: END_MEETING_FAILED_COPY };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: END_MEETING_FAILED_COPY };
  }
  const { meetingId } = parsed.data;

  const result = await endMeeting(meetingId);
  if (!result.ok && result.code === MEETING_END_NOT_JOINED_CODE) {
    log.info('Meeting end refused — the client member has not joined this meeting yet', {
      meetingId,
      status: result.status,
      code: result.code,
    });
    return { success: false, error: END_MEETING_NOT_JOINED_COPY };
  }
  if (!result.ok && result.code === MEETING_END_NOT_STARTED_CODE) {
    // BAL-474 (R6-C6) — an EXPECTED refusal (End before the start), logged at `info` like its sibling.
    log.info('Meeting end refused — the meeting has not reached its scheduled start', {
      meetingId,
      status: result.status,
      code: result.code,
    });
    return { success: false, error: END_MEETING_NOT_STARTED_COPY };
  }
  if (!result.ok) {
    // ⚠ `error`, NOT `warn`: unlike the polled read, this is a single user-initiated act that
    // did not do what the person asked. The api's fixed literal and the status are the fields
    // that make it diagnosable; the wire copy says only that the call is still running.
    log.error('Meeting end refused', {
      meetingId,
      status: result.status,
      code: result.code,
    });
    return { success: false, error: END_MEETING_FAILED_COPY };
  }

  log.info('Meeting ended by participant', {
    meetingId,
    alreadyEnded: result.data.alreadyEnded === true,
    endedBy: result.data.endedBy ?? null,
  });
  return { success: true, alreadyEnded: result.data.alreadyEnded === true };
}
