'use server';

import 'server-only';

import { z } from 'zod';
import { actionItemsRepository } from '@balo/db';
import { trackServerAndFlush, ACTION_ITEM_SERVER_EVENTS } from '@/lib/analytics/server';
import { log } from '@/lib/logging';
import {
  ACTION_ITEM_GONE,
  INVALID_REQUEST,
  requireActionItemUser,
  runActionItemAction,
  type ActionItemActionResult,
} from './action-item-action-shared';

/** `.strict()` — soft-remove one action item from a live, active engagement. */
const removeInputSchema = z
  .object({
    engagementId: z.uuid(),
    actionItemId: z.uuid(),
  })
  .strict();

export interface RemoveActionItemInput {
  engagementId: string;
  actionItemId: string;
}

/**
 * Soft-remove an action item from a live, active engagement (any participant lens).
 * Auth / IDOR / active-guard via the shared runner, then `actionItemsRepository.softRemove`
 * under its lock (the row then disappears from `listByEngagement`). Fires
 * `ACTION_ITEM_REMOVED`. No notification.
 */
export async function removeActionItemAction(
  input: RemoveActionItemInput
): Promise<ActionItemActionResult> {
  const auth = await requireActionItemUser();
  if (!auth.ok) {
    return { success: false, error: auth.error };
  }
  const parsed = removeInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: INVALID_REQUEST };
  }
  const { engagementId, actionItemId } = parsed.data;

  return runActionItemAction(
    auth.user,
    engagementId,
    { actionItemId },
    'Failed to remove action item',
    async ({ user, engagement, actionItem }) => {
      if (actionItem === undefined) {
        return { success: false, error: ACTION_ITEM_GONE };
      }

      const removed = await actionItemsRepository.softRemove({
        actionItemId: actionItem.id,
        userId: user.id,
      });

      trackServerAndFlush(ACTION_ITEM_SERVER_EVENTS.REMOVED, {
        engagement_id: engagement.id,
        action_item_id: removed.id,
        distinct_id: user.id,
      });

      log.info('Action item removed', {
        engagementId: engagement.id,
        actionItemId: removed.id,
        userId: user.id,
      });
      return { success: true, actionItemId: removed.id };
    }
  );
}
