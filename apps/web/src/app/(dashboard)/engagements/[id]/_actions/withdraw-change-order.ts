'use server';

import 'server-only';

import { z } from 'zod';
import { engagementChangeOrdersRepository } from '@balo/db';
import { deriveEngagementParties, expertSideActorLabel } from '@/lib/engagement/engagement-parties';
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
  requesterPayload,
} from './change-order-action-shared';

const withdrawChangeOrderSchema = z.object({ engagementId: z.uuid(), orderId: z.uuid() }).strict();

/**
 * The expert withdraws a SENT change. Gated on the engagement capability `manage_engagement`;
 * `expectedFrom: 'sent'` stops a stale tab withdrawing an order that has since been decided.
 * Nothing on the project changes. Fires `CHANGE_ORDER_WITHDRAWN` and publishes
 * `change_order.withdrawn` (client owner, in-app).
 */
export async function withdrawChangeOrderAction(input: {
  engagementId: string;
  orderId: string;
}): Promise<EngagementActionResult> {
  const auth = await requireSignedInUser();
  if (!auth.ok) {
    return { success: false, error: auth.error };
  }
  const parsed = withdrawChangeOrderSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: INVALID_REQUEST };
  }
  const { engagementId, orderId } = parsed.data;
  const { user } = auth;

  return runEngagementLifecycleAction(
    engagementId,
    { userId: user.id, changeOrderId: orderId },
    'Failed to withdraw change order',
    () => gateChangeOrderExpert(user, engagementId),
    async (engagement, authorized) => {
      const order = await engagementChangeOrdersRepository.withdraw({
        engagementId,
        orderId,
        userId: user.id,
        expectedFrom: 'sent',
      });

      trackServerAndFlush(ENGAGEMENT_SERVER_EVENTS.CHANGE_ORDER_WITHDRAWN, {
        ...changeOrderLinesProps(order, engagement.pricingMethod, user.id),
        days_to_decision: daysToDecision(order, new Date()),
        acting_as: authorized.actor.actingAs,
      });

      const parties = deriveEngagementParties(engagement);
      const recipientId = await resolveClientRecipientId(engagement.company.id);
      publishNotificationEvent('change_order.withdrawn', {
        ...payloadBase('withdrawn', order, engagement, parties),
        recipientId,
        actorExpertLabel: expertSideActorLabel(engagement, parties, user),
        ...(await requesterPayload(order.requestedByUserId, recipientId, engagement.company.id)),
      }).catch(() => {
        // publishNotificationEvent logs internally.
      });

      log.info('Change order withdrawn', {
        engagementId,
        changeOrderId: order.id,
        userId: user.id,
        pricing_method: engagement.pricingMethod,
      });
      return { success: true };
    }
  );
}
