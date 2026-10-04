'use server';

import 'server-only';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  actionItemsRepository,
  EngagementNotActiveError,
  InvalidActionItemTransitionError,
} from '@balo/db';
import { trackServerAndFlush, ACTION_ITEM_SERVER_EVENTS } from '@/lib/analytics/server';
import { errorMessage, log } from '@/lib/logging';
import { mayToggleCaseActionItems } from '@/lib/cases/may-toggle-case-action-items';
import {
  ACTION_ITEM_GONE,
  GENERIC_FAILURE,
  INVALID_REQUEST,
  STATUS_CHANGED,
  type ActionItemActionResult,
} from '@/app/(dashboard)/engagements/[id]/_actions/action-item-action-shared';
import { authorizeCaseMutation } from '../_lib/authorize-case-mutation';

const setCaseActionItemStatusSchema = z
  .object({
    engagementId: z.uuid(),
    actionItemId: z.uuid(),
    status: z.enum(['open', 'done']),
  })
  .strict();

const CASE_CLOSED = 'This case is closed, so its action items can no longer change.';
const DENIED = "You don't have permission to do that.";

/**
 * Complete (open → done) or reopen (done → open) an action item on an OPEN case — the case-grain
 * sibling of `engagements/[id]/_actions/set-action-item-status.ts`, which gates through the
 * project-only `findWithMilestones` and so can never resolve a case id.
 *
 * Gates, in order:
 *   1. Strict Zod, before any read.
 *   2. `authorizeCaseMutation` — onboarded session, the full tenancy gate, case-type coherence.
 *      `engagementId` names the subject; nothing about WHO may act is read from input.
 *   3. Case still open (`closed_at IS NULL`). The repository re-checks under its lock
 *      (`lockActiveEngagement` → `EngagementNotActiveError`) for a close racing this write.
 *   4. `mayToggleCaseActionItems` — the per-lens capability, shared with both loaders.
 *   5. IDOR: the item must belong to THIS case and be live.
 *
 * Returns the project action's `ActionItemActionResult` so `ActionItemsPanel` settles either.
 */
export async function setCaseActionItemStatusAction(input: {
  engagementId: string;
  actionItemId: string;
  status: 'open' | 'done';
}): Promise<ActionItemActionResult> {
  const parsed = setCaseActionItemStatusSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: INVALID_REQUEST };
  }
  const { engagementId, actionItemId, status } = parsed.data;

  const gate = await authorizeCaseMutation({ engagementId });
  if (!gate.ok) {
    return { success: false, error: gate.error };
  }
  const { user, lens, companyId, caseRow } = gate;

  if (caseRow.closedAt !== null) {
    return { success: false, error: CASE_CLOSED };
  }

  try {
    if (!(await mayToggleCaseActionItems(user, { lens, engagementId, companyId }))) {
      log.warn('Case action item status change denied', {
        engagementId,
        actionItemId,
        userId: user.id,
        lens,
      });
      return { success: false, error: DENIED };
    }

    const actionItem = await actionItemsRepository.findById(actionItemId);
    if (actionItem?.engagementId !== engagementId || actionItem.deletedAt !== null) {
      return { success: false, error: ACTION_ITEM_GONE };
    }

    if (status === 'done') {
      const updated = await actionItemsRepository.complete({ actionItemId, userId: user.id });
      trackServerAndFlush(ACTION_ITEM_SERVER_EVENTS.COMPLETED, {
        engagement_id: engagementId,
        engagement_type: 'case',
        action_item_id: updated.id,
        completed_by_role: lens,
        was_ai_extracted: actionItem.source === 'ai_extracted',
        distinct_id: user.id,
      });
      log.info('Action item completed', { engagementId, actionItemId, userId: user.id });
    } else {
      const updated = await actionItemsRepository.reopen({ actionItemId, userId: user.id });
      trackServerAndFlush(ACTION_ITEM_SERVER_EVENTS.REOPENED, {
        engagement_id: engagementId,
        engagement_type: 'case',
        action_item_id: updated.id,
        reopened_by_role: lens,
        distinct_id: user.id,
      });
      log.info('Action item reopened', { engagementId, actionItemId, userId: user.id });
    }

    revalidatePath('/cases/' + engagementId);
    return { success: true, actionItemId };
  } catch (error) {
    if (error instanceof EngagementNotActiveError) {
      return { success: false, error: CASE_CLOSED };
    }
    if (error instanceof InvalidActionItemTransitionError) {
      return { success: false, error: STATUS_CHANGED };
    }
    log.error('Failed to update case action item status', {
      engagementId,
      actionItemId,
      userId: user.id,
      error: errorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: GENERIC_FAILURE };
  }
}
