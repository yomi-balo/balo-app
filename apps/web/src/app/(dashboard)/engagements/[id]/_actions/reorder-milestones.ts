'use server';

import 'server-only';

import { z } from 'zod';
import {
  engagementMilestonesRepository,
  EngagementNotActiveError,
  MilestoneReorderMismatchError,
} from '@balo/db';
import { log } from '@/lib/logging';
import {
  ENGAGEMENT_LOCKED,
  INVALID_REQUEST,
  PLAN_CHANGED,
  requireExpertUser,
  runExpertEngagementAction,
  type MilestoneActionResult,
} from './milestone-action-shared';

/**
 * `.strict()` — ids only, no descriptive/commercial fields. `orderedMilestoneIds` MUST
 * be the full live set (the repo enforces the exact-permutation invariant under its
 * lock); `min(1)` because reorder is meaningless on an empty plan.
 */
const reorderInputSchema = z
  .object({
    engagementId: z.uuid(),
    orderedMilestoneIds: z.array(z.uuid()).min(1).max(200),
  })
  .strict();

export interface ReorderMilestonesInput {
  engagementId: string;
  orderedMilestoneIds: string[];
}

/**
 * Expert reorders the live milestones of an active engagement (D3). Writes only
 * `sort_order` (NOT a REPLACE-ALL — status / provenance / value / completion
 * timestamps are untouched). Fires NO analytics event and NO notification (reorder is
 * not in the ticket's scope-change list). The two typed races map to friendly copy:
 * `EngagementNotActiveError → ENGAGEMENT_LOCKED`, `MilestoneReorderMismatchError →
 * PLAN_CHANGED` (a stale tab racing a concurrent add/remove). `revalidatePath` is
 * handled by the shared runner on success.
 */
export async function reorderMilestonesAction(
  input: ReorderMilestonesInput
): Promise<MilestoneActionResult> {
  const auth = await requireExpertUser();
  if (!auth.ok) {
    return { success: false, error: auth.error };
  }
  const parsed = reorderInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: INVALID_REQUEST };
  }
  const { engagementId, orderedMilestoneIds } = parsed.data;

  return runExpertEngagementAction(
    auth.user,
    engagementId,
    {},
    'Failed to reorder milestones',
    async ({ user, engagement }) => {
      try {
        await engagementMilestonesRepository.reorder({
          engagementId,
          userId: user.id,
          orderedMilestoneIds,
        });
      } catch (error) {
        if (error instanceof EngagementNotActiveError) {
          return { success: false, error: ENGAGEMENT_LOCKED };
        }
        if (error instanceof MilestoneReorderMismatchError) {
          return { success: false, error: PLAN_CHANGED };
        }
        throw error; // → the shared GENERIC_FAILURE boundary
      }

      log.info('Milestones reordered', {
        engagementId: engagement.id,
        userId: user.id,
        count: orderedMilestoneIds.length,
      });
      // Reorder has no single target milestone — the rail reconciles via router.refresh().
      return { success: true, milestoneId: '', status: 'pending' };
    }
  );
}
