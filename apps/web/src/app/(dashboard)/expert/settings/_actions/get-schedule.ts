'use server';
import 'server-only';

import { expertsRepository } from '@balo/db';
import { withAuth } from '@/lib/auth/with-auth';
import { log, errorMessage } from '@/lib/logging';
import { internalApiFetch } from '../_lib/internal-api';
import type { ScheduleApiResponse, WorkInFlight } from '../_types/schedule';

/**
 * GET response: the wire-contract schedule plus the session-derived expertProfileId,
 * which the client tab uses only as the `expert_id` analytics dimension.
 */
export interface ScheduleLoadResult extends ScheduleApiResponse {
  expertProfileId: string;
  workInFlight: WorkInFlight;
}

const NO_WORK_IN_FLIGHT: WorkInFlight = { upcomingConsultations: 0, activeProjects: 0 };

/**
 * The pause dialog's "carries on as normal" counts are informational, so a failed count must
 * not fail the schedule tab: it falls back to zeros, which the dialog words as the both-zero copy.
 */
async function loadWorkInFlight(expertProfileId: string, userId: string): Promise<WorkInFlight> {
  try {
    return await expertsRepository.countWorkInFlight(expertProfileId, new Date());
  } catch (err: unknown) {
    log.warn('Failed to count work in flight; falling back to zeros', {
      userId,
      expertProfileId,
      error: errorMessage(err),
    });
    return NO_WORK_IN_FLIGHT;
  }
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
    const [schedule, workInFlight] = await Promise.all([
      internalApiFetch<ScheduleApiResponse>(
        `/api/experts/${expertProfileId}/schedule`,
        {},
        'schedule-api'
      ),
      loadWorkInFlight(expertProfileId, session.user.id),
    ]);
    return { ...schedule, expertProfileId, workInFlight };
  } catch (err: unknown) {
    log.error('Failed to fetch expert schedule', {
      userId: session.user.id,
      expertProfileId,
      error: errorMessage(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return null;
  }
});
