'use server';
import 'server-only';

import { revalidatePath } from 'next/cache';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveApprovedExpert, APPROVED_EXPERT_REQUIRED_ERROR } from '@/lib/auth/approved-expert';
import { log, errorMessage } from '@/lib/logging';
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
  try {
    const gate = await resolveApprovedExpert(session.user);
    if (!gate.ok) {
      return { success: false, error: APPROVED_EXPERT_REQUIRED_ERROR };
    }
    const { expertProfileId } = gate;

    await internalApiFetch<{ success: boolean }>(
      `/api/experts/${expertProfileId}/schedule`,
      // actorUserId rides a header (DELETE carries no JSON body, and a query param
      // would log the UUID in the request URL) for ADR-1030 audit attribution; the
      // IDOR gate is the session-derived expertProfileId.
      { method: 'DELETE', headers: { 'x-actor-user-id': session.user.id } },
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
      expertProfileId: session.user.expertProfileId,
      error: errorMessage(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return { success: false, error: 'Failed to clear schedule. Please try again.' };
  }
});
