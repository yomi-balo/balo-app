'use server';
import 'server-only';

import { withAuth } from '@/lib/auth/with-auth';
import { log } from '@/lib/logging';
import { internalApiFetch } from '../_lib/internal-api';
import type { ScheduleData } from '../_types/schedule';

/**
 * GET response: the wire-contract schedule plus the session-derived expertProfileId,
 * which the client tab uses only as the `expert_id` analytics dimension.
 */
export interface ScheduleLoadResult extends ScheduleData {
  expertProfileId: string;
}

/**
 * Loads the signed-in expert's weekly schedule. Returns null when the schedule
 * can't be loaded (no expert profile or API error) — the caller renders the error
 * state. A loaded-but-unset schedule comes back with `rules: []`.
 *
 * IDOR gate: the expertProfileId is derived from the session, never the client.
 */
export const getScheduleAction = withAuth(async (session): Promise<ScheduleLoadResult | null> => {
  if (session.user.activeMode !== 'expert' || !session.user.expertProfileId) {
    return null;
  }
  const expertProfileId = session.user.expertProfileId;

  try {
    const schedule = await internalApiFetch<ScheduleData>(
      `/api/experts/${expertProfileId}/schedule`,
      {},
      'schedule-api'
    );
    return { ...schedule, expertProfileId };
  } catch (err: unknown) {
    log.error('Failed to fetch expert schedule', {
      userId: session.user.id,
      expertProfileId,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return null;
  }
});
