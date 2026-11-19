'use server';

import 'server-only';

import { z } from 'zod';
import type { CallRingStatus } from '@balo/shared/meetings';
import { requireOnboardedUser } from '@/lib/auth/session';
import { isImpersonatedSession } from '@/lib/auth/impersonation';
import { postStopRing } from '@/lib/call-now/call-now-api-client';
import { log } from '@/lib/logging';

/**
 * BAL-651 — the caller stops the ring ("Stop calling"). The api answers `200` with the status the
 * ring really has, so a stop that loses a race to a connect comes back `connected` and the room
 * stays put. There is no refusal arm beyond "it did not work".
 */
export type StopCallNowRingResult = { ok: true; status: CallRingStatus } | { ok: false };

const inputSchema = z.object({ ringId: z.uuid() });

export async function stopCallNowRingAction(input: {
  ringId: string;
}): Promise<StopCallNowRingResult> {
  const user = await requireOnboardedUser();
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { ok: false };

  if (isImpersonatedSession(user)) {
    log.warn('Call now stop refused — impersonated session', {
      userId: user.id,
      impersonatorUserId: user.impersonatorUserId,
      ringId: parsed.data.ringId,
    });
    return { ok: false };
  }

  const result = await postStopRing(parsed.data.ringId);
  if (!result.ok) {
    log.warn('Call now stop refused', {
      ringId: parsed.data.ringId,
      userId: user.id,
      status: result.status,
      code: result.code,
    });
    return { ok: false };
  }
  log.info('Call now stopped', { ringId: parsed.data.ringId, status: result.data.status });
  return { ok: true, status: result.data.status };
}
