'use server';

import 'server-only';

import { z } from 'zod';
import { actionItemsRepository } from '@balo/db';
import { trackServerAndFlush, ACTION_ITEM_SERVER_EVENTS } from '@/lib/analytics/server';
import { log } from '@/lib/logging';
import {
  INVALID_REQUEST,
  publishActionItemAssigned,
  requireActionItemUser,
  runActionItemAction,
  type ActionItemActionResult,
} from './action-item-action-shared';

/**
 * `.strict()` so ANY unknown key fails the parse → `INVALID_REQUEST` (no meetingId from
 * the manual UI — the provenance seam is the ai_extracted path only). `body` is plain
 * text, trimmed, capped at 2000; `dueAt` is an optional ISO datetime (parsed to a Date).
 */
const createInputSchema = z
  .object({
    engagementId: z.uuid(),
    body: z.string().trim().min(1).max(2000),
    assigneeParty: z.enum(['client', 'expert']).optional(),
    dueAt: z.iso.datetime().optional(),
  })
  .strict();

export interface CreateActionItemInput {
  engagementId: string;
  body: string;
  assigneeParty?: 'client' | 'expert';
  dueAt?: string;
}

/**
 * Add a manual action item to a live, active engagement. Any participant lens (client /
 * expert / admin) may write — the IDOR-safe engagement gate + active guard run in the
 * shared runner, then `actionItemsRepository.createManual` under its lock. Fires
 * `ACTION_ITEM_CREATED`; when an `assigneeParty` is supplied the create also assigns, so
 * it additionally publishes `action_item.assigned` (fire-and-forget) to the assigned side.
 */
export async function createActionItemAction(
  input: CreateActionItemInput
): Promise<ActionItemActionResult> {
  const auth = await requireActionItemUser();
  if (!auth.ok) {
    return { success: false, error: auth.error };
  }
  const parsed = createInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: INVALID_REQUEST };
  }
  const { engagementId, body, assigneeParty, dueAt } = parsed.data;

  return runActionItemAction(
    auth.user,
    engagementId,
    {},
    'Failed to create action item',
    async ({ user, engagement, lens }) => {
      const created = await actionItemsRepository.createManual({
        engagementId,
        userId: user.id,
        body,
        assigneeParty: assigneeParty ?? null,
        dueAt: dueAt ? new Date(dueAt) : null,
      });

      trackServerAndFlush(ACTION_ITEM_SERVER_EVENTS.CREATED, {
        engagement_id: engagement.id,
        source: 'manual',
        assignee_role: assigneeParty ?? 'unassigned',
        count: 1,
        distinct_id: user.id,
      });

      // A create-with-assignee assigns → notify the assigned side.
      if (assigneeParty !== undefined) {
        await publishActionItemAssigned(engagement, lens, user, created, assigneeParty);
      }

      log.info('Action item created', {
        engagementId: engagement.id,
        actionItemId: created.id,
        userId: user.id,
      });
      return { success: true, actionItemId: created.id };
    }
  );
}
