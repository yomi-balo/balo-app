'use server';

import 'server-only';

import { z } from 'zod';
import { engagementChangeOrdersRepository } from '@balo/db';
import { deriveEngagementParties } from '@/lib/engagement/engagement-parties';
import { trackServerAndFlush, ENGAGEMENT_SERVER_EVENTS } from '@/lib/analytics/server';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import { log } from '@/lib/logging';
import {
  INVALID_REQUEST,
  requireSignedInUser,
  resolveClientRecipientId,
  runEngagementLifecycleAction,
  type EngagementActionResult,
} from './engagement-lifecycle-shared';
import {
  changeOrderLinesProps,
  daysToDecision,
  gateChangeOrderExpert,
  payloadBase,
} from './change-order-action-shared';

const answerChangeRequestSchema = z
  .object({
    engagementId: z.uuid(),
    orderId: z.uuid(),
    answer: z.string().trim().min(1).max(2000),
  })
  .strict();

/**
 * The expert answers a client's change request without proposing a change order. The order is
 * stored as `declined` with the answer in `decline_reason` and shown to the client as
 * "Answered". Gated on the engagement capability `manage_engagement`. `expectedFrom:
 * 'requested'` stops a stale tab answering an order that has since moved. Fires
 * `CHANGE_ORDER_DECLINED` (`answered_without_change_order: true`) and publishes
 * `change_order.answered` to the client owner. The answer is never logged.
 */
export async function answerChangeRequestAction(input: {
  engagementId: string;
  orderId: string;
  answer: string;
}): Promise<EngagementActionResult> {
  const auth = await requireSignedInUser();
  if (!auth.ok) {
    return { success: false, error: auth.error };
  }
  const parsed = answerChangeRequestSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: INVALID_REQUEST };
  }
  const { engagementId, orderId, answer } = parsed.data;
  const { user } = auth;

  return runEngagementLifecycleAction(
    engagementId,
    { userId: user.id, changeOrderId: orderId },
    'Failed to answer change request',
    () => gateChangeOrderExpert(user, engagementId),
    async (engagement) => {
      const order = await engagementChangeOrdersRepository.decline({
        engagementId,
        orderId,
        userId: user.id,
        reason: answer,
        expectedFrom: 'requested',
      });

      trackServerAndFlush(ENGAGEMENT_SERVER_EVENTS.CHANGE_ORDER_DECLINED, {
        ...changeOrderLinesProps(order, engagement.pricingMethod, user.id),
        days_to_decision: daysToDecision(order, new Date()),
        answered_without_change_order: true,
      });

      const parties = deriveEngagementParties(engagement);
      const recipientId = await resolveClientRecipientId(engagement.company.id);
      publishNotificationEvent('change_order.answered', {
        ...payloadBase('answered', order, engagement, parties),
        recipientId,
        actorExpertLabel: parties.expertRetroFirstMention,
        answer,
      }).catch(() => {
        // publishNotificationEvent logs internally.
      });

      log.info('Change request answered', {
        engagementId,
        changeOrderId: order.id,
        userId: user.id,
        pricing_method: engagement.pricingMethod,
      });
      return { success: true };
    }
  );
}
