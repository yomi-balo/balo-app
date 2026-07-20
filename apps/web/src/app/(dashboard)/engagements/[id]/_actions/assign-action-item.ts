'use server';

import 'server-only';

import { z } from 'zod';
import { actionItemsRepository } from '@balo/db';
import { trackServerAndFlush, ACTION_ITEM_SERVER_EVENTS } from '@/lib/analytics/server';
import { log } from '@/lib/logging';
import {
  ACTION_ITEM_GONE,
  INVALID_REQUEST,
  publishActionItemAssigned,
  requireActionItemUser,
  runActionItemAction,
  type ActionItemActionResult,
} from './action-item-action-shared';

/**
 * `.strict()` — assign (or reassign, or clear) an item to a SIDE. `assigneeParty: null`
 * unassigns; `'client'`/`'expert'` (re)assigns. The nullable enum is required (the
 * client always sends an explicit target, including `null` to clear).
 */
const assignInputSchema = z
  .object({
    engagementId: z.uuid(),
    actionItemId: z.uuid(),
    assigneeParty: z.enum(['client', 'expert']).nullable(),
  })
  .strict();

export interface AssignActionItemInput {
  engagementId: string;
  actionItemId: string;
  assigneeParty: 'client' | 'expert' | null;
}

/**
 * Assign / reassign / clear an action item's SIDE on a live, active engagement (any
 * participant lens). Auth / IDOR / active-guard via the shared runner, then
 * `actionItemsRepository.assign` under its lock. Fires `ACTION_ITEM_ASSIGNED`; when the
 * item is (re)assigned to a side (not cleared) it additionally publishes
 * `action_item.assigned` (fire-and-forget) — a reassign re-notifies by design.
 */
export async function assignActionItemAction(
  input: AssignActionItemInput
): Promise<ActionItemActionResult> {
  const auth = await requireActionItemUser();
  if (!auth.ok) {
    return { success: false, error: auth.error };
  }
  const parsed = assignInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: INVALID_REQUEST };
  }
  const { engagementId, actionItemId, assigneeParty } = parsed.data;

  return runActionItemAction(
    auth.user,
    engagementId,
    { actionItemId },
    'Failed to assign action item',
    async ({ user, engagement, lens, actionItem }) => {
      if (actionItem === undefined) {
        return { success: false, error: ACTION_ITEM_GONE };
      }

      const updated = await actionItemsRepository.assign({
        actionItemId: actionItem.id,
        userId: user.id,
        assigneeParty,
      });

      trackServerAndFlush(ACTION_ITEM_SERVER_EVENTS.ASSIGNED, {
        engagement_id: engagement.id,
        action_item_id: updated.id,
        assignee_role: assigneeParty ?? 'unassigned',
        distinct_id: user.id,
      });

      // A (re)assignment to a side notifies that side; a clear (null) does not.
      if (assigneeParty !== null) {
        await publishActionItemAssigned(engagement, lens, user, updated, assigneeParty);
      }

      log.info('Action item assigned', {
        engagementId: engagement.id,
        actionItemId: updated.id,
        userId: user.id,
        assignee_role: assigneeParty ?? 'unassigned',
      });
      return { success: true, actionItemId: updated.id };
    }
  );
}
