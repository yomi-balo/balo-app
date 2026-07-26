'use server';
import 'server-only';

import { revalidatePath } from 'next/cache';
import { withAuth } from '@/lib/auth/with-auth';
import { log } from '@/lib/logging';
import { calendarApiFetch } from '../_lib/calendar-api';

export interface DeleteAvailabilityOverrideInput {
  overrideId: string;
}

export interface DeleteAvailabilityOverrideResult {
  success: boolean;
  error?: string;
}

/**
 * Removes a time-off block for the signed-in expert. Proxies to the Fastify
 * route, which soft-deletes (ownership-scoped to `expertProfileId`) and rebuilds
 * the availability cache. `expertProfileId` is derived server-side, so a client
 * cannot delete another expert's blocks.
 */
export const deleteAvailabilityOverrideAction = withAuth(
  async (
    session,
    input: DeleteAvailabilityOverrideInput
  ): Promise<DeleteAvailabilityOverrideResult> => {
    const expertProfileId = session.user.expertProfileId;
    if (!expertProfileId) {
      return { success: false, error: 'No expert profile found' };
    }

    try {
      await calendarApiFetch<{ success: boolean }>('/api/experts/availability-overrides/delete', {
        method: 'POST',
        body: JSON.stringify({ expertProfileId, overrideId: input.overrideId }),
      });

      log.info('Availability override deleted', {
        userId: session.user.id,
        expertProfileId,
        overrideId: input.overrideId,
      });

      revalidatePath('/expert/settings');
      return { success: true };
    } catch (err: unknown) {
      log.error('Failed to delete availability override', {
        userId: session.user.id,
        expertProfileId,
        overrideId: input.overrideId,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to remove time off',
      };
    }
  }
);
