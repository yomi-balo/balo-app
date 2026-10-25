'use server';

import 'server-only';

import { z } from 'zod';
import { engagementChangeOrdersRepository } from '@balo/db';
import { CAPABILITIES } from '@/lib/authz';
import { deriveEngagementParties, personAtCompany } from '@/lib/engagement/engagement-parties';
import { trackServerAndFlush, ENGAGEMENT_SERVER_EVENTS } from '@/lib/analytics/server';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import { log } from '@/lib/logging';
import {
  INVALID_REQUEST,
  requireSignedInUser,
  runEngagementLifecycleAction,
  type EngagementActionResult,
} from './engagement-lifecycle-shared';
import {
  changeOrderLinesProps,
  daysToDecision,
  gateChangeOrderClient,
  payloadBase,
} from './change-order-action-shared';

const declineChangeOrderSchema = z
  .object({
    engagementId: z.uuid(),
    orderId: z.uuid(),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();

/**
 * The client declines a SENT change. Gated on the membership capability
 * `approve_own_proposals`; a reason is required. `expectedFrom: 'sent'` stops a stale tab
 * declining an order that has since moved. Nothing on the project changes. Fires
 * `CHANGE_ORDER_DECLINED` and publishes `change_order.declined` (the delivering expert, reason
 * verbatim, and the Balo admins). The reason is never logged.
 */
export async function declineChangeOrderAction(input: {
  engagementId: string;
  orderId: string;
  reason: string;
}): Promise<EngagementActionResult> {
  const auth = await requireSignedInUser();
  if (!auth.ok) {
    return { success: false, error: auth.error };
  }
  const parsed = declineChangeOrderSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: INVALID_REQUEST };
  }
  const { engagementId, orderId, reason } = parsed.data;
  const { user } = auth;

  return runEngagementLifecycleAction(
    engagementId,
    { userId: user.id, changeOrderId: orderId },
    'Failed to decline change order',
    () => gateChangeOrderClient(user, engagementId, CAPABILITIES.APPROVE_OWN_PROPOSALS),
    async (engagement) => {
      const order = await engagementChangeOrdersRepository.decline({
        engagementId,
        orderId,
        userId: user.id,
        reason,
        expectedFrom: 'sent',
      });

      trackServerAndFlush(ENGAGEMENT_SERVER_EVENTS.CHANGE_ORDER_DECLINED, {
        ...changeOrderLinesProps(order, engagement.pricingMethod, user.id),
        days_to_decision: daysToDecision(order, new Date()),
        answered_without_change_order: false,
      });

      const parties = deriveEngagementParties(engagement);
      publishNotificationEvent('change_order.declined', {
        ...payloadBase('declined', order, engagement, parties),
        expertProfileId: engagement.expertProfileId,
        actorClientLabel: personAtCompany(user, parties.clientCompanyName),
        reason,
        clientCompanyName: parties.clientCompanyName,
      }).catch(() => {
        // publishNotificationEvent logs internally.
      });

      log.info('Change order declined', {
        engagementId,
        changeOrderId: order.id,
        userId: user.id,
        pricing_method: engagement.pricingMethod,
      });
      return { success: true };
    }
  );
}
