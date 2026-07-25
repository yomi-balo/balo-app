'use server';
import 'server-only';

import { revalidatePath } from 'next/cache';
import { withAuth } from '@/lib/auth/with-auth';
import { log } from '@/lib/logging';
import { internalApiFetch } from '../_lib/internal-api';

export interface ClearScheduleResult {
  success: boolean;
  error?: string;
}

/**
 * Clears the signed-in expert's weekly availability rules (soft-delete).
 * IDOR gate: the expertProfileId is derived from the session, never the client.
 */
export const clearScheduleAction = withAuth(async (session): Promise<ClearScheduleResult> => {
  if (session.user.activeMode !== 'expert' || !session.user.expertProfileId) {
    return { success: false, error: 'Expert profile required' };
  }
  const expertProfileId = session.user.expertProfileId;

  try {
    await internalApiFetch<{ success: boolean }>(
      `/api/experts/${expertProfileId}/schedule`,
      { method: 'DELETE' },
      'schedule-api'
    );

    log.info('Expert schedule cleared', {
      userId: session.user.id,
      expertProfileId,
    });

    revalidatePath('/expert/settings');

    return { success: true };
  } catch (err: unknown) {
    log.error('Failed to clear expert schedule', {
      userId: session.user.id,
      expertProfileId,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return { success: false, error: 'Failed to clear schedule. Please try again.' };
  }
});
