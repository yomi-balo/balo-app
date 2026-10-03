'use server';
import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { withAuth } from '@/lib/auth/with-auth';
import { log, errorMessage } from '@/lib/logging';
import { internalApiFetch } from '../_lib/internal-api';

const setWorkAvailabilitySchema = z.object({ availableForWork: z.boolean() });

export interface SetWorkAvailabilityResult {
  success: boolean;
  error?: string;
}

/**
 * Pauses or resumes new work for the signed-in expert. The flag flip is audited and drops the
 * slot caches in the API route; this action only gates and forwards.
 * IDOR gate: the expertProfileId is derived from the session, never the client body.
 */
export const setWorkAvailabilityAction = withAuth(
  async (session, input: { availableForWork: boolean }): Promise<SetWorkAvailabilityResult> => {
    if (session.user.activeMode !== 'expert' || !session.user.expertProfileId) {
      return { success: false, error: 'Expert profile required' };
    }
    const expertProfileId = session.user.expertProfileId;

    try {
      const { availableForWork } = setWorkAvailabilitySchema.parse(input);

      await internalApiFetch<{ success: boolean }>(
        `/api/experts/${expertProfileId}/work-availability`,
        {
          method: 'PUT',
          // actorUserId is audit attribution only (ADR-1030); the IDOR gate is the
          // session-derived expertProfileId above.
          body: JSON.stringify({ availableForWork, actorUserId: session.user.id }),
        },
        'schedule-api'
      );

      log.info('Expert work availability changed', {
        userId: session.user.id,
        expertProfileId,
        availableForWork,
      });

      revalidatePath('/expert/settings');
      revalidatePath('/expert/calendar');
      revalidatePath('/dashboard');

      return { success: true };
    } catch (err: unknown) {
      log.error('Failed to change expert work availability', {
        userId: session.user.id,
        expertProfileId,
        error: errorMessage(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      return { success: false, error: 'Failed to update availability. Please try again.' };
    }
  }
);
