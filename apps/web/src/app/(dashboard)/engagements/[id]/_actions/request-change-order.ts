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
import { gateChangeOrderClient, payloadBase } from './change-order-action-shared';

const requestChangeOrderSchema = z
  .object({ engagementId: z.uuid(), note: z.string().trim().min(1).max(2000) })
  .strict();

/**
 * The client asks for a change to the live project (`requested`). Gated on the membership
 * capability `participate`. Fires `CHANGE_ORDER_REQUESTED` and publishes
 * `change_order.requested` (the delivering expert, note verbatim, and the Balo admins).
 * The note is never logged.
 */
export async function requestChangeOrderAction(input: {
  engagementId: string;
  note: string;
}): Promise<EngagementActionResult> {
  const auth = await requireSignedInUser();
  if (!auth.ok) {
    return { success: false, error: auth.error };
  }
  const parsed = requestChangeOrderSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: INVALID_REQUEST };
  }
  const { engagementId, note } = parsed.data;
  const { user } = auth;

  return runEngagementLifecycleAction(
    engagementId,
    { userId: user.id },
    'Failed to request change order',
    () => gateChangeOrderClient(user, engagementId, CAPABILITIES.PARTICIPATE),
    async (engagement) => {
      const order = await engagementChangeOrdersRepository.requestByClient({
        engagementId,
        userId: user.id,
        note,
      });

      trackServerAndFlush(ENGAGEMENT_SERVER_EVENTS.CHANGE_ORDER_REQUESTED, {
        engagement_id: engagementId,
        change_order_id: order.id,
        pricing_method: engagement.pricingMethod,
        initiated_by: 'client',
        distinct_id: user.id,
      });

      const parties = deriveEngagementParties(engagement);
      publishNotificationEvent('change_order.requested', {
        ...payloadBase('requested', order, engagement, parties),
        expertProfileId: engagement.expertProfileId,
        actorClientLabel: personAtCompany(user, parties.clientCompanyName),
        note,
        expertPartyLabel: parties.expertParty,
      }).catch(() => {
        // publishNotificationEvent logs internally.
      });

      log.info('Change order requested', {
        engagementId,
        changeOrderId: order.id,
        userId: user.id,
        pricing_method: engagement.pricingMethod,
      });
      return { success: true };
    }
  );
}
