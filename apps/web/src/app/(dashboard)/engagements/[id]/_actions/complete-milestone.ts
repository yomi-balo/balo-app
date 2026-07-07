'use server';

import 'server-only';

import { z } from 'zod';
import { engagementMilestonesRepository } from '@balo/db';
import { deriveEngagementParties } from '@/lib/engagement/engagement-parties';
import { trackServerAndFlush, ENGAGEMENT_SERVER_EVENTS } from '@/lib/analytics/server';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import { log } from '@/lib/logging';
import {
  DAY_MS,
  INVALID_REQUEST,
  deriveEngagementTitle,
  formatCompletedOn,
  requireExpertUser,
  resolveClientRecipientId,
  runExpertMilestoneAction,
  runMilestoneTransition,
  type MilestoneActionResult,
} from './milestone-action-shared';

const completeInputSchema = z.object({
  engagementId: z.uuid(),
  milestoneId: z.uuid(),
  // Plain text v1, link-friendly, trimmed; empty → treated as no note.
  completionNote: z.string().trim().max(4000).optional(),
});

/**
 * Expert completes an in-progress milestone (in_progress → completed), capturing an
 * OPTIONAL free-text delivery note. Auth/IDOR/status via the shared chain, then
 * `engagementMilestonesRepository.complete`. Fires `MILESTONE_COMPLETED` and publishes
 * `engagement.milestone_completed` (client owner email + in-app; admins in-app) —
 * fire-and-forget.
 */
export async function completeMilestoneAction(input: {
  engagementId: string;
  milestoneId: string;
  completionNote?: string;
}): Promise<MilestoneActionResult> {
  const auth = await requireExpertUser();
  if (!auth.ok) {
    return { success: false, error: auth.error };
  }
  const parsed = completeInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: INVALID_REQUEST };
  }
  const rawNote = parsed.data.completionNote;
  // Empty / whitespace note → omitted (`.trim()` already ran; length guards '').
  const note = rawNote && rawNote.length > 0 ? rawNote : undefined;

  return runExpertMilestoneAction(
    auth.user,
    parsed.data,
    'in_progress',
    'Failed to complete milestone',
    async ({ user, engagement, milestone }) => {
      const outcome = await runMilestoneTransition(() =>
        engagementMilestonesRepository.complete({
          milestoneId: milestone.id,
          userId: user.id,
          completionNote: note,
        })
      );
      if (!outcome.ok) {
        return { success: false, error: outcome.error };
      }
      const updated = outcome.value;

      const cycleTimeDays =
        updated.startedAt !== null && updated.completedAt !== null
          ? Math.max(
              0,
              Math.floor((updated.completedAt.getTime() - updated.startedAt.getTime()) / DAY_MS)
            )
          : 0;
      trackServerAndFlush(ENGAGEMENT_SERVER_EVENTS.MILESTONE_COMPLETED, {
        engagement_id: engagement.id,
        milestone_id: updated.id,
        cycle_time_days: cycleTimeDays,
        has_completion_note: note !== undefined,
        distinct_id: user.id,
      });

      // ── Notify (fire-and-forget) — client company owner + admins ──
      const parties = deriveEngagementParties(engagement);
      const recipientId = await resolveClientRecipientId(engagement.company.id);
      const completedAtMs = updated.completedAt?.getTime() ?? Date.now();
      // {n} is best-effort from the pre-load + this completion (informational).
      const completedCount =
        engagement.milestones.filter((m) => m.status === 'completed').length + 1;
      publishNotificationEvent('engagement.milestone_completed', {
        correlationId: `${updated.id}:${completedAtMs}`,
        engagementId: engagement.id,
        milestoneId: updated.id,
        recipientId,
        expertPartyLabel: parties.expertParty,
        actorExpertLabel: parties.expertRetroFirstMention,
        projectTitle: deriveEngagementTitle(engagement, parties),
        milestoneTitle: updated.title,
        completedOn: formatCompletedOn(updated.completedAt ?? new Date()),
        completionNote: note,
        completedCount,
        totalCount: engagement.milestones.length,
      }).catch(() => {
        // publishNotificationEvent logs internally.
      });

      log.info('Milestone completed', {
        engagementId: engagement.id,
        milestoneId: updated.id,
        userId: user.id,
        has_completion_note: note !== undefined,
      });
      return { success: true, milestoneId: updated.id, status: updated.status };
    }
  );
}
