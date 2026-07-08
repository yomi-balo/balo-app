'use server';

import 'server-only';

import { z } from 'zod';
import { engagementMilestonesRepository } from '@balo/db';
import { trackServerAndFlush, ENGAGEMENT_SERVER_EVENTS } from '@/lib/analytics/server';
import { log } from '@/lib/logging';
import {
  DAY_MS,
  INVALID_REQUEST,
  requireExpertUser,
  runExpertMilestoneAction,
  runMilestoneTransition,
  type MilestoneActionResult,
} from './milestone-action-shared';

const startInputSchema = z.object({ engagementId: z.uuid(), milestoneId: z.uuid() });

/**
 * Expert starts a pending milestone (pending → in_progress). Auth → expert-lens gate
 * → engagement-active guard → IDOR → status pre-check (via the shared chain), then
 * `engagementMilestonesRepository.start`. Fires the `MILESTONE_STARTED` server event.
 * DELIBERATELY SILENT — no notification (starting is low-signal).
 */
export async function startMilestoneAction(input: {
  engagementId: string;
  milestoneId: string;
}): Promise<MilestoneActionResult> {
  const auth = await requireExpertUser();
  if (!auth.ok) {
    return { success: false, error: auth.error };
  }
  const parsed = startInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: INVALID_REQUEST };
  }

  return runExpertMilestoneAction(
    auth.user,
    parsed.data,
    'pending',
    'Failed to start milestone',
    async ({ user, engagement, milestone }) => {
      const outcome = await runMilestoneTransition(() =>
        engagementMilestonesRepository.start({ milestoneId: milestone.id, userId: user.id })
      );
      if (!outcome.ok) {
        return { success: false, error: outcome.error };
      }
      const updated = outcome.value;

      const kickoffMs = (engagement.activatedAt ?? engagement.createdAt).getTime();
      const startedMs = updated.startedAt?.getTime() ?? Date.now();
      trackServerAndFlush(ENGAGEMENT_SERVER_EVENTS.MILESTONE_STARTED, {
        engagement_id: engagement.id,
        milestone_id: updated.id,
        days_since_kickoff: Math.max(0, Math.floor((startedMs - kickoffMs) / DAY_MS)),
        distinct_id: user.id,
      });

      log.info('Milestone started', {
        engagementId: engagement.id,
        milestoneId: updated.id,
        userId: user.id,
      });
      return { success: true, milestoneId: updated.id, status: updated.status };
    }
  );
}
