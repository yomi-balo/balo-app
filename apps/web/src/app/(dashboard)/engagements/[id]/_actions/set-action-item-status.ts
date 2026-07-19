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

/** `.strict()` — the target status the client wants: `done` completes, `open` reopens. */
const setStatusInputSchema = z
  .object({
    engagementId: z.uuid(),
    actionItemId: z.uuid(),
    status: z.enum(['open', 'done']),
  })
  .strict();

export interface SetActionItemStatusInput {
  engagementId: string;
  actionItemId: string;
  status: 'open' | 'done';
}

/**
 * Complete (open → done) or reopen (done → open) an action item on a live, active
 * engagement (any participant lens). Auth / IDOR / active-guard via the shared runner,
 * then `complete` or `reopen` under the repo's lock — an illegal transition (double
 * complete / reopen) throws `InvalidActionItemTransitionError`, mapped to the friendly
 * `STATUS_CHANGED` race copy by the runner. Fires `ACTION_ITEM_COMPLETED` (with the
 * actor lens + whether the item was ai_extracted) or `ACTION_ITEM_REOPENED`.
 */
export async function setActionItemStatusAction(
  input: SetActionItemStatusInput
): Promise<ActionItemActionResult> {
  const auth = await requireActionItemUser();
  if (!auth.ok) {
    return { success: false, error: auth.error };
  }
  const parsed = setStatusInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: INVALID_REQUEST };
  }
  const { engagementId, actionItemId, status } = parsed.data;

  return runActionItemAction(
    auth.user,
    engagementId,
    { actionItemId },
    'Failed to update action item status',
    async ({ user, engagement, lens, actionItem }) => {
      if (actionItem === undefined) {
        return { success: false, error: ACTION_ITEM_GONE };
      }

      if (status === 'done') {
        const updated = await actionItemsRepository.complete({
          actionItemId: actionItem.id,
          userId: user.id,
        });
        trackServerAndFlush(ACTION_ITEM_SERVER_EVENTS.COMPLETED, {
          engagement_id: engagement.id,
          action_item_id: updated.id,
          completed_by_role: lens,
          was_ai_extracted: actionItem.source === 'ai_extracted',
          distinct_id: user.id,
        });
        log.info('Action item completed', {
          engagementId: engagement.id,
          actionItemId: updated.id,
          userId: user.id,
        });
        return { success: true, actionItemId: updated.id };
      }

      const updated = await actionItemsRepository.reopen({
        actionItemId: actionItem.id,
        userId: user.id,
      });
      trackServerAndFlush(ACTION_ITEM_SERVER_EVENTS.REOPENED, {
        engagement_id: engagement.id,
        action_item_id: updated.id,
        distinct_id: user.id,
      });
      log.info('Action item reopened', {
        engagementId: engagement.id,
        actionItemId: updated.id,
        userId: user.id,
      });
      return { success: true, actionItemId: updated.id };
    }
  );
}
