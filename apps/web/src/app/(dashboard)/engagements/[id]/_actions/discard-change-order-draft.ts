'use server';

import 'server-only';

import { z } from 'zod';
import { engagementChangeOrdersRepository } from '@balo/db';
import { log } from '@/lib/logging';
import {
  INVALID_REQUEST,
  STATUS_CHANGED,
  requireSignedInUser,
  runEngagementLifecycleAction,
  type EngagementActionResult,
} from './engagement-lifecycle-shared';
import { gateChangeOrderExpert } from './change-order-action-shared';

const discardDraftSchema = z.object({ engagementId: z.uuid(), orderId: z.uuid() }).strict();

/**
 * The expert discards their draft change. A draft made from a client request returns to
 * `requested` (the request stays open and the draft's note and lines are cleared); a draft
 * the expert opened unprompted is withdrawn. Gated on the engagement capability
 * `manage_engagement`. No analytics and no notification: the client never saw the draft.
 */
export async function discardChangeOrderDraftAction(input: {
  engagementId: string;
  orderId: string;
}): Promise<EngagementActionResult> {
  const auth = await requireSignedInUser();
  if (!auth.ok) {
    return { success: false, error: auth.error };
  }
  const parsed = discardDraftSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: INVALID_REQUEST };
  }
  const { engagementId, orderId } = parsed.data;
  const { user } = auth;

  return runEngagementLifecycleAction(
    engagementId,
    { userId: user.id, changeOrderId: orderId },
    'Failed to discard change order draft',
    () => gateChangeOrderExpert(user, engagementId),
    async () => {
      const orders = await engagementChangeOrdersRepository.listForEngagement(engagementId);
      const draft = orders.find((order) => order.id === orderId);
      if (draft === undefined) {
        return { success: false, error: STATUS_CHANGED };
      }
      if (draft.requestedAt === null) {
        await engagementChangeOrdersRepository.withdraw({
          engagementId,
          orderId,
          userId: user.id,
          expectedFrom: 'draft',
        });
      } else {
        await engagementChangeOrdersRepository.returnDraftToRequest({
          engagementId,
          orderId,
          userId: user.id,
        });
      }

      log.info('Change order draft discarded', {
        engagementId,
        changeOrderId: orderId,
        userId: user.id,
        returned_to_request: draft.requestedAt !== null,
      });
      return { success: true };
    }
  );
}
