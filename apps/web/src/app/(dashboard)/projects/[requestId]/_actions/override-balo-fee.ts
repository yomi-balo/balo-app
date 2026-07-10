'use server';

import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { projectRequestsRepository } from '@balo/db';
import { MAX_BALO_FEE_BPS, MIN_BALO_FEE_BPS } from '@balo/shared/pricing';
import { getCurrentUser } from '@/lib/auth/session';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from '@/lib/authz/platform';
import { trackServerAndFlush, PROJECT_SERVER_EVENTS } from '@/lib/analytics/server';
import { log } from '@/lib/logging';

const inputSchema = z.object({
  requestId: z.uuid(),
  // Same bounds as the DB CHECK (`balo_fee_bps >= 0 AND <= 10000`) — a shared
  // MIN/MAX from `@balo/shared/pricing` so the client parse, this Zod range, and
  // the DB CHECK can never drift.
  feeBps: z.number().int().min(MIN_BALO_FEE_BPS).max(MAX_BALO_FEE_BPS),
});

const PERMISSION_DENIED = 'You do not have permission to do this.';
const INVALID_FEE = 'Enter a fee between 0% and 100%.';
const REQUEST_GONE = 'This request no longer exists.';
const GENERIC_FAILURE = 'Could not update the fee. Please try again.';

export type OverrideBaloFeeResult =
  | { success: true; previousBps: number; newBps: number; changed: boolean }
  | { success: false; error: string };

/**
 * Admin per-project Balo-fee override (BAL-358). Sets `project_requests.balo_fee_bps`
 * for ONE request; proposals already snapshot their fee at submit/accept, so this
 * only affects proposals submitted from now on.
 *
 * Authorization is the NEW platform-capability axis (`MANAGE_PLATFORM_FEES`), NOT
 * `requireAdmin()` — the observer LENS decides who can view the surface; this
 * capability decides who can mutate the fee. An unauthenticated or uncapable caller
 * gets a generic permission error (no existence leak). The mutation + its audit row
 * commit atomically in `updateBaloFeeBps`; a genuine no-op (`newBps === current`)
 * writes nothing and emits no analytics.
 */
export async function overrideBaloFee(
  input: z.infer<typeof inputSchema>
): Promise<OverrideBaloFeeResult> {
  const user = await getCurrentUser();
  if (!user) {
    return { success: false, error: PERMISSION_DENIED };
  }
  if (!hasPlatformCapability(user, PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES)) {
    return { success: false, error: PERMISSION_DENIED };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: INVALID_FEE };
  }
  const { requestId, feeBps } = parsed.data;

  try {
    // Friendly stale-UI pre-check (the repo's not-found throw is the authoritative
    // guard for a race between this read and the update).
    const request = await projectRequestsRepository.findById(requestId);
    if (request === undefined) {
      return { success: false, error: REQUEST_GONE };
    }

    const result = await projectRequestsRepository.updateBaloFeeBps({
      requestId,
      newBps: feeBps,
      actorUserId: user.id,
    });

    if (result.changed) {
      log.info('Admin overrode project Balo fee', {
        requestId,
        actorUserId: user.id,
        previousBps: result.previousBps,
        newBps: result.newBps,
      });
      trackServerAndFlush(PROJECT_SERVER_EVENTS.ADMIN_PROJECT_FEE_OVERRIDDEN, {
        project_request_id: requestId,
        previous_bps: result.previousBps,
        new_bps: result.newBps,
        distinct_id: user.id,
      });
    }

    revalidatePath(`/projects/${requestId}`);

    return {
      success: true,
      previousBps: result.previousBps,
      newBps: result.newBps,
      changed: result.changed,
    };
  } catch (error) {
    log.error('Failed to override project Balo fee', {
      requestId,
      actorUserId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: GENERIC_FAILURE };
  }
}
