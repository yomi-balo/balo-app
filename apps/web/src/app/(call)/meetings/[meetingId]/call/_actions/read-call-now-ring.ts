'use server';

import 'server-only';

import { z } from 'zod';
import type { CallRingStatus } from '@balo/shared/meetings';
import { requireOnboardedUser } from '@/lib/auth/session';
import { isImpersonatedSession } from '@/lib/auth/impersonation';
import { getCallNowRing } from '@/lib/call-now/call-now-api-client';
import { log } from '@/lib/logging';

/**
 * BAL-651 — one poll of the caller's ring, for the "Calling" stage. The api's ring read is
 * party-scoped, so a ring that is not the viewer's is a plain `404`.
 *
 * `transient` separates a blip the poll should ride out (transport, 5xx, 429) from an answer it
 * should stop on (the ring is gone, or the session ended): the hook backs off on the first and
 * stops on the second.
 */
export type ReadCallNowRingResult =
  | { ok: true; status: CallRingStatus; expiresAtIso: string }
  | { ok: false; transient: boolean };

const inputSchema = z.object({ ringId: z.uuid() });

function isTransient(status: number): boolean {
  return status === 0 || status === 429 || status >= 500;
}

export async function readCallNowRingAction(input: {
  ringId: string;
}): Promise<ReadCallNowRingResult> {
  const user = await requireOnboardedUser();
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, transient: false };

  if (isImpersonatedSession(user)) {
    log.warn('Call now ring read refused — impersonated session', {
      userId: user.id,
      impersonatorUserId: user.impersonatorUserId,
      ringId: parsed.data.ringId,
    });
    return { ok: false, transient: false };
  }

  const result = await getCallNowRing(parsed.data.ringId);
  if (!result.ok) {
    const transient = isTransient(result.status);
    if (transient) {
      log.warn('Call now ring poll failed', {
        ringId: parsed.data.ringId,
        status: result.status,
      });
    }
    return { ok: false, transient };
  }
  return { ok: true, status: result.data.status, expiresAtIso: result.data.expiresAt };
}
