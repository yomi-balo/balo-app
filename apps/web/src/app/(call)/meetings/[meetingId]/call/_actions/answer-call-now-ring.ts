'use server';

import 'server-only';

import { z } from 'zod';
import type { MemberJoinResponse } from '@balo/shared/meetings';
import { requireOnboardedUser } from '@/lib/auth/session';
import { isImpersonatedSession } from '@/lib/auth/impersonation';
import { viewerApiCredentialIsLive } from '@/lib/api/balo-api-client';
import { getCallNowRing, postAnswerRing } from '@/lib/call-now/call-now-api-client';
import { isCallNowFundingCode } from '@/lib/call-now/call-now-funding';
import type { CallNowFundingCode } from '@/lib/call-now/call-now-types';
import { resolveCaseAccess } from '@/lib/cases/resolve-case-access';
import { log } from '@/lib/logging';

/**
 * BAL-651 — the client's commit on an expert-started ring: the Join click IS the answer. The api
 * checks the same 15-minute funding window a start does and, once clear, answers with the join
 * grant so the room can open without a second round trip.
 *
 * `engagementId` rides on the two refusals the room answers by going back to the case or by asking
 * for credit; `expertProfileId` rides on `funding` only, for the funding step's pre-flight request.
 * Both are read from the viewer's own ring read and case access.
 */
export type AnswerCallNowRingFailureCode =
  | 'impersonation_refused'
  | 'invalid'
  | 'session_expired'
  | 'ring_not_ringing'
  | 'unavailable'
  | 'funding'
  | 'funding_unavailable'
  | 'rate_limited'
  | 'failed';

export type AnswerCallNowRingResult =
  | { ok: true; grant: MemberJoinResponse }
  | {
      ok: false;
      code: AnswerCallNowRingFailureCode;
      fundingCode?: CallNowFundingCode;
      engagementId?: string;
      expertProfileId?: string;
    };

const inputSchema = z.object({ ringId: z.uuid() }).strict();

function failure(code: AnswerCallNowRingFailureCode): AnswerCallNowRingResult {
  return { ok: false, code };
}

/** The api's refusal as the room can act on it. Anything unlisted is `unavailable`. */
function codeForRefusal(status: number, code: string): AnswerCallNowRingFailureCode {
  if (status === 503 && code === 'booking_funding_unavailable') return 'funding_unavailable';
  if (status === 0 || status >= 500) return 'failed';
  if (status === 429) return 'rate_limited';
  if (status === 401) return 'session_expired';
  if (status === 409 && code === 'ring_not_ringing') return 'ring_not_ringing';
  if (status === 409 && isCallNowFundingCode(code)) return 'funding';
  return 'unavailable';
}

async function fundingFailure(
  ringId: string,
  userId: string,
  fundingCode: CallNowFundingCode
): Promise<AnswerCallNowRingResult> {
  const ring = await getCallNowRing(ringId);
  if (!ring.ok) return failure('unavailable');
  const access = await resolveCaseAccess(ring.data.engagementId, userId);
  if (access === null) return failure('unavailable');
  return {
    ok: false,
    code: 'funding',
    fundingCode,
    engagementId: access.engagementId,
    expertProfileId: access.expertProfileId,
  };
}

/** A ring that is no longer ringing: the room goes back to the case, so name it when it can be read. */
async function notRingingFailure(ringId: string): Promise<AnswerCallNowRingResult> {
  const ring = await getCallNowRing(ringId);
  return ring.ok
    ? { ok: false, code: 'ring_not_ringing', engagementId: ring.data.engagementId }
    : failure('ring_not_ringing');
}

export async function answerCallNowRingAction(input: {
  ringId: string;
}): Promise<AnswerCallNowRingResult> {
  const user = await requireOnboardedUser();

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return failure('invalid');
  const { ringId } = parsed.data;

  // Before the credential pre-flight, which an impersonated session always fails.
  if (isImpersonatedSession(user)) {
    log.warn('Call now answer refused — impersonated session', {
      userId: user.id,
      impersonatorUserId: user.impersonatorUserId,
      ringId,
    });
    return failure('impersonation_refused');
  }

  if (!(await viewerApiCredentialIsLive())) {
    log.info('Call now answer refused — viewer credential expired', { userId: user.id });
    return failure('session_expired');
  }

  try {
    const result = await postAnswerRing(ringId);
    if (result.ok) {
      log.info('Call now answered', { ringId });
      return { ok: true, grant: result.data };
    }

    const code = codeForRefusal(result.status, result.code);
    if (code === 'funding' && isCallNowFundingCode(result.code)) {
      return await fundingFailure(ringId, user.id, result.code);
    }
    if (code === 'ring_not_ringing') return await notRingingFailure(ringId);
    if (code === 'unavailable') {
      log.warn('Call now answer refused', { ringId, status: result.status, code: result.code });
    }
    return failure(code);
  } catch (error) {
    log.error('Call now answer failed', {
      ringId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return failure('failed');
  }
}
