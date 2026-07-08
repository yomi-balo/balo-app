'use server';

import 'server-only';

import { z } from 'zod';
import { engagementMilestonesRepository } from '@balo/db';
import { trackServerAndFlush, ENGAGEMENT_SERVER_EVENTS } from '@/lib/analytics/server';
import { log } from '@/lib/logging';
import {
  INVALID_REQUEST,
  MILESTONE_GONE,
  publishScopeChange,
  requireExpertUser,
  runExpertEngagementAction,
  runMilestoneTransition,
  type MilestoneActionResult,
} from './milestone-action-shared';

/** `.strict()` — no descriptive/commercial fields; a remove carries ids only. */
const removeInputSchema = z.object({ engagementId: z.uuid(), milestoneId: z.uuid() }).strict();

export interface RemoveMilestoneInput {
  engagementId: string;
  milestoneId: string;
}

/**
 * Expert removes (soft-deletes) a milestone from a live, active engagement (D3). A
 * `completed` milestone can be removed (D0 policy; the danger-tone confirm is a UI
 * concern) — the scope-change notification is the compensating transparency. Captures
 * `was_completed` + `had_source_provenance` from the PRE-loaded node (observability),
 * fires `MILESTONE_REMOVED`, and publishes `engagement.scope_changed`
 * (`changeKind:'removed'`) — fire-and-forget.
 */
export async function removeMilestoneAction(
  input: RemoveMilestoneInput
): Promise<MilestoneActionResult> {
  const auth = await requireExpertUser();
  if (!auth.ok) {
    return { success: false, error: auth.error };
  }
  const parsed = removeInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: INVALID_REQUEST };
  }
  const { engagementId, milestoneId } = parsed.data;

  return runExpertEngagementAction(
    auth.user,
    engagementId,
    { milestoneId },
    'Failed to remove milestone',
    async ({ user, engagement, milestone }) => {
      if (milestone === undefined) {
        // Unreachable — the `{ milestoneId }` IDOR check guarantees the node.
        return { success: false, error: MILESTONE_GONE };
      }

      // Captured BEFORE the soft-delete (from the pre-loaded node, for clarity).
      const wasCompleted = milestone.status === 'completed';
      const hadSourceProvenance = milestone.sourceProposalMilestoneId !== null;

      const outcome = await runMilestoneTransition(() =>
        engagementMilestonesRepository.softDelete({ milestoneId: milestone.id, userId: user.id })
      );
      if (!outcome.ok) {
        return { success: false, error: outcome.error };
      }
      const removed = outcome.value;

      trackServerAndFlush(ENGAGEMENT_SERVER_EVENTS.MILESTONE_REMOVED, {
        engagement_id: engagement.id,
        milestone_id: removed.id,
        was_completed: wasCompleted,
        had_source_provenance: hadSourceProvenance,
        distinct_id: user.id,
      });

      await publishScopeChange(engagement, {
        changeKind: 'removed',
        milestoneId: removed.id,
        milestoneTitle: removed.title,
        correlationId: `${removed.id}:removed`,
      });

      log.info('Milestone removed', {
        engagementId: engagement.id,
        milestoneId: removed.id,
        userId: user.id,
        was_completed: wasCompleted,
      });
      return { success: true, milestoneId: removed.id, status: removed.status };
    }
  );
}
