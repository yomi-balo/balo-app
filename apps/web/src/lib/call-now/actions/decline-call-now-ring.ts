'use server';

import 'server-only';

import { z } from 'zod';
import { requireOnboardedUser } from '@/lib/auth/session';
import { isImpersonatedSession } from '@/lib/auth/impersonation';
import { viewerApiCredentialIsLive } from '@/lib/api/balo-api-client';
import { log } from '@/lib/logging';
import { postDeclineRing } from '../call-now-api-client';

/**
 * BAL-653 — the callee's "Not now": tells the caller the ring was turned down. The api's decline
 * is idempotent and answers `200` with the ring's real status when it had already ended, so a late
 * "Not now" is still `{ ok: true }`.
 */
export type DeclineCallNowRingResult = { ok: true } | { ok: false };

const inputSchema = z.object({ ringId: z.uuid() }).strict();

const FAILED: DeclineCallNowRingResult = { ok: false };

export async function declineCallNowRingAction(input: {
  ringId: string;
}): Promise<DeclineCallNowRingResult> {
  const user = await requireOnboardedUser();

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return FAILED;
  const { ringId } = parsed.data;

  // Before the credential pre-flight, which an impersonated session always fails.
  if (isImpersonatedSession(user)) {
    log.warn('Call now decline refused — impersonated session', {
      userId: user.id,
      impersonatorUserId: user.impersonatorUserId,
      ringId,
    });
    return FAILED;
  }

  if (!(await viewerApiCredentialIsLive())) {
    log.info('Call now decline refused — viewer credential expired', { userId: user.id });
    return FAILED;
  }

  try {
    const result = await postDeclineRing(ringId);
    if (result.ok) {
      log.info('Call now declined', { ringId });
      return { ok: true };
    }
    log.warn('Call now decline refused', { ringId, status: result.status, code: result.code });
    return FAILED;
  } catch (error) {
    log.error('Call now decline failed', {
      ringId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return FAILED;
  }
}
