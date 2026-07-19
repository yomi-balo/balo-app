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

/**
 * `.strict()` — edit `body` and/or `dueAt` only (no status change). An explicit
 * `dueAt: null` CLEARS the due date; an omitted `dueAt` skips it (partial edit). At
 * least one of `body`/`dueAt` must be present (guarded below) → an empty edit is
 * `INVALID_REQUEST`.
 */
const updateInputSchema = z
  .object({
    engagementId: z.uuid(),
    actionItemId: z.uuid(),
    body: z.string().trim().min(1).max(2000).optional(),
    dueAt: z.iso.datetime().nullable().optional(),
  })
  .strict();

export interface UpdateActionItemInput {
  engagementId: string;
  actionItemId: string;
  body?: string;
  dueAt?: string | null;
}

/**
 * Edit an action item's `body` and/or `due_at` on a live, active engagement (any
 * participant lens). Auth / IDOR / active-guard via the shared runner, then
 * `actionItemsRepository.edit` under its lock (only provided keys are written; an
 * explicit `null` `dueAt` clears). Fires `ACTION_ITEM_EDITED` with the changed field
 * names. No notification (an edit is not an assignment).
 */
export async function updateActionItemAction(
  input: UpdateActionItemInput
): Promise<ActionItemActionResult> {
  const auth = await requireActionItemUser();
  if (!auth.ok) {
    return { success: false, error: auth.error };
  }
  const parsed = updateInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: INVALID_REQUEST };
  }
  const { engagementId, actionItemId, body, dueAt } = parsed.data;

  // An edit with nothing to change is a malformed request.
  if (body === undefined && dueAt === undefined) {
    return { success: false, error: INVALID_REQUEST };
  }

  return runActionItemAction(
    auth.user,
    engagementId,
    { actionItemId },
    'Failed to update action item',
    async ({ user, engagement, actionItem }) => {
      if (actionItem === undefined) {
        return { success: false, error: ACTION_ITEM_GONE };
      }

      const fieldsChanged: string[] = [];
      const editArgs: {
        actionItemId: string;
        userId: string;
        body?: string;
        dueAt?: Date | null;
      } = { actionItemId: actionItem.id, userId: user.id };
      if (body !== undefined) {
        editArgs.body = body;
        fieldsChanged.push('body');
      }
      if (dueAt !== undefined) {
        editArgs.dueAt = dueAt === null ? null : new Date(dueAt);
        fieldsChanged.push('due_at');
      }

      const updated = await actionItemsRepository.edit(editArgs);

      trackServerAndFlush(ACTION_ITEM_SERVER_EVENTS.EDITED, {
        engagement_id: engagement.id,
        action_item_id: updated.id,
        fields_changed: fieldsChanged,
        distinct_id: user.id,
      });

      log.info('Action item edited', {
        engagementId: engagement.id,
        actionItemId: updated.id,
        userId: user.id,
        fields_changed: fieldsChanged,
      });
      return { success: true, actionItemId: updated.id };
    }
  );
}
