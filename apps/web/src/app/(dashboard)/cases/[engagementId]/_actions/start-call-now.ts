'use server';

import 'server-only';

import { z } from 'zod';
import { requireOnboardedUser } from '@/lib/auth/session';
import { isImpersonatedSession } from '@/lib/auth/impersonation';
import { isExpiredCredentialFailure, viewerApiCredentialIsLive } from '@/lib/api/balo-api-client';
import { postStartCallNow } from '@/lib/call-now/call-now-api-client';
import { isCallNowFundingCode } from '@/lib/call-now/call-now-funding';
import { errorMessage, log } from '@/lib/logging';
import type {
  StartCallNowPlainFailureCode,
  StartCallNowResult,
} from './_types/call-now-action-types';

/**
 * BAL-651 — START A CALL NOW FROM THE CASE SURFACE. A thin, authenticated hop onto
 * `POST /cases/:id/call-now` (BAL-649/650): the api owns every gate (membership, availability,
 * funding), so this action only refuses what web must (an impersonated session, a dead
 * credential) and translates the api's literal into a code the dialog can act on.
 *
 * ⚠ A FUNDING REFUSAL CARRIES THE CODE ONLY. The api's top-up figure is never forwarded to the
 * browser: the funding step reads its own figure from the pre-flight, which is billing-rights aware.
 *
 * ⚠ NO LENS, ROLE OR `activeMode` READ HERE. Who may ring whom is the api's decision; the
 * dialog's two arms are chosen from the loader's view, not from anything in this module.
 */

const startCallNowSchema = z
  .object({
    engagementId: z.uuid(),
    inPlaceOfMeetingId: z.uuid().optional(),
    /** The entry tap's id, minted client-side; the api persists it on the ring. */
    attemptId: z.uuid(),
  })
  .strict();

/** The api literals that map one-to-one onto a failure code. */
const LITERAL_FAILURE: Readonly<Record<string, StartCallNowPlainFailureCode>> = {
  call_now_unavailable: 'unavailable',
  case_not_found: 'unavailable',
  in_place_not_allowed: 'invalid',
  in_place_not_eligible: 'in_place_not_eligible',
  venue_unavailable: 'venue_unavailable',
  booking_funding_unavailable: 'funding_unavailable',
};

function failureCodeFor(status: number, code: string): StartCallNowPlainFailureCode | null {
  if (isExpiredCredentialFailure(status, code)) return 'session_expired';
  if (status === 429) return 'rate_limited';
  return LITERAL_FAILURE[code] ?? null;
}

export async function startCallNowAction(input: unknown): Promise<StartCallNowResult> {
  const user = await requireOnboardedUser();

  const parsed = startCallNowSchema.safeParse(input);
  if (!parsed.success) {
    log.warn('Call now start failed validation', { userId: user.id });
    return { ok: false, code: 'invalid' };
  }
  const { engagementId, inPlaceOfMeetingId, attemptId } = parsed.data;

  // ⚠ BEFORE the credential pre-flight, which an impersonated session always fails (it holds no
  // access token by design) and would misreport as an expired session.
  if (isImpersonatedSession(user)) {
    log.warn('Call now start refused — impersonated session', {
      userId: user.id,
      engagementId,
    });
    return { ok: false, code: 'impersonation_refused' };
  }

  if (!(await viewerApiCredentialIsLive())) {
    log.info('Call now start refused before the api hop — viewer credential expired', {
      userId: user.id,
    });
    return { ok: false, code: 'session_expired' };
  }

  try {
    const result = await postStartCallNow(
      engagementId,
      inPlaceOfMeetingId === undefined ? { attemptId } : { inPlaceOfMeetingId, attemptId }
    );
    if (result.ok) {
      log.info('Call now started', {
        engagementId,
        meetingId: result.data.meetingId,
        placement: result.data.placement,
      });
      return { ok: true, meetingId: result.data.meetingId, ringId: result.data.ringId };
    }

    if (isCallNowFundingCode(result.code)) {
      return {
        ok: false,
        code: 'funding',
        fundingCode: result.code,
      };
    }
    const known = failureCodeFor(result.status, result.code);
    if (known !== null) return { ok: false, code: known };

    log.warn('Call now start refused with an unrecognised code', {
      engagementId,
      status: result.status,
      code: result.code,
    });
    return { ok: false, code: 'failed' };
  } catch (error) {
    log.error('Call now start failed', {
      engagementId,
      error: errorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { ok: false, code: 'failed' };
  }
}
