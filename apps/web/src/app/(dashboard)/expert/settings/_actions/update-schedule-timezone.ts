'use server';
import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { isValidTimezone } from '@balo/shared/timezone';
import { withAuth } from '@/lib/auth/with-auth';
import { log, errorMessage } from '@/lib/logging';
import { internalApiFetch } from '../_lib/internal-api';

const timezoneSchema = z.string().refine(isValidTimezone, 'Invalid timezone');

export interface UpdateScheduleTimezoneResult {
  success: boolean;
  error?: string;
}

/**
 * Updates the signed-in expert's timezone. The PATCH route writes BOTH
 * expert_profiles.timezone (resolver) and users.timezone in one transaction so
 * the two stay in sync (BAL-234). Country is left to the explicit country picker.
 * IDOR gate: the expertProfileId is derived from the session, never the client.
 */
export const updateScheduleTimezoneAction = withAuth(
  async (session, timezone: string): Promise<UpdateScheduleTimezoneResult> => {
    if (session.user.activeMode !== 'expert' || !session.user.expertProfileId) {
      return { success: false, error: 'Expert profile required' };
    }
    const expertProfileId = session.user.expertProfileId;

    try {
      const validTimezone = timezoneSchema.parse(timezone);

      await internalApiFetch<{ success: boolean }>(
        `/api/experts/${expertProfileId}/timezone`,
        {
          method: 'PATCH',
          body: JSON.stringify({ timezone: validTimezone, actorUserId: session.user.id }),
        },
        'schedule-api'
      );

      log.info('Expert schedule timezone updated', {
        userId: session.user.id,
        expertProfileId,
        timezone: validTimezone,
      });

      revalidatePath('/expert/settings');

      return { success: true };
    } catch (err: unknown) {
      log.error('Failed to update expert schedule timezone', {
        userId: session.user.id,
        expertProfileId,
        error: errorMessage(err),
        stack: err instanceof Error ? err.stack : undefined,
      });

      if (err instanceof z.ZodError) {
        return { success: false, error: err.issues[0]?.message ?? 'Invalid timezone' };
      }
      return { success: false, error: 'Failed to update timezone. Please try again.' };
    }
  }
);
