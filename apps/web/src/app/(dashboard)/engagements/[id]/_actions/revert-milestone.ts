'use server';

import 'server-only';

import { z } from 'zod';
import { engagementMilestonesRepository } from '@balo/db';
import { deriveEngagementParties } from '@/lib/engagement/engagement-parties';
import { trackServerAndFlush, ENGAGEMENT_SERVER_EVENTS } from '@/lib/analytics/server';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import { log } from '@/lib/logging';
import {
  HOUR_MS,
  INVALID_REQUEST,
  requireExpertUser,
  resolveClientRecipientId,
  runExpertMilestoneAction,
  runMilestoneTransition,
  type MilestoneActionResult,
} from './milestone-action-shared';

const revertInputSchema = z.object({ engagementId: z.uuid(), milestoneId: z.uuid() });

/**
 * Expert reverts a completed milestone (completed → in_progress) — the repo CLEARS
 * the completion record. Auth/IDOR/status via the shared chain, then
 * `engagementMilestonesRepository.revert`. Fires `MILESTONE_REVERTED` and publishes
 * `engagement.milestone_reverted` (client owner + admins, in-app — reverts are never
 * silent). CRITICAL: reads `completedAt` from the PRE-LOADED milestone before
 * delegating (`revert()` nulls it) for the `hours_since_completed` metric.
 */
export async function revertMilestoneAction(input: {
  engagementId: string;
  milestoneId: string;
}): Promise<MilestoneActionResult> {
  const auth = await requireExpertUser();
  if (!auth.ok) {
    return { success: false, error: auth.error };
  }
  const parsed = revertInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: INVALID_REQUEST };
  }

  return runExpertMilestoneAction(
    auth.user,
    parsed.data,
    'completed',
    'Failed to revert milestone',
    async ({ user, engagement, milestone }) => {
      // Read the completion timestamp BEFORE the revert nulls it (the metric gotcha).
      const completedAtBefore = milestone.completedAt;

      const outcome = await runMilestoneTransition(() =>
        engagementMilestonesRepository.revert({ milestoneId: milestone.id, userId: user.id })
      );
      if (!outcome.ok) {
        return { success: false, error: outcome.error };
      }
      const updated = outcome.value;

      const hoursSinceCompleted =
        completedAtBefore === null
          ? 0
          : Math.max(0, Math.floor((Date.now() - completedAtBefore.getTime()) / HOUR_MS));
      trackServerAndFlush(ENGAGEMENT_SERVER_EVENTS.MILESTONE_REVERTED, {
        engagement_id: engagement.id,
        milestone_id: updated.id,
        hours_since_completed: hoursSinceCompleted,
        distinct_id: user.id,
      });

      // ── Notify (fire-and-forget) — client company owner + admins, in-app ──
      const parties = deriveEngagementParties(engagement);
      const recipientId = await resolveClientRecipientId(engagement.company.id);
      publishNotificationEvent('engagement.milestone_reverted', {
        correlationId: `${updated.id}:reverted:${updated.updatedAt.getTime()}`,
        engagementId: engagement.id,
        milestoneId: updated.id,
        recipientId,
        actorExpertLabel: parties.expertRetroFirstMention,
        milestoneTitle: updated.title,
      }).catch(() => {
        // publishNotificationEvent logs internally.
      });

      log.info('Milestone reverted', {
        engagementId: engagement.id,
        milestoneId: updated.id,
        userId: user.id,
      });
      return { success: true, milestoneId: updated.id, status: updated.status };
    }
  );
}
