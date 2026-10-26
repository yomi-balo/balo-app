'use server';

import 'server-only';

import { z } from 'zod';
import { engagementChangeOrdersRepository } from '@balo/db';
import { changeOrderMinutesDelta } from '@balo/shared/engagements';
import { CAPABILITIES } from '@/lib/authz';
import { deriveEngagementParties, personAtCompany } from '@/lib/engagement/engagement-parties';
import { formatHours, signedHours, signedMoney } from '@/lib/engagement/change-order-view';
import { loadProjectSettlement } from '@/lib/engagement/change-order-settlement';
import { buildChangeOrderCreditAlertDetail } from '@/lib/engagement/change-order-credit-alert';
import { raiseAdminAlert } from '@/lib/admin-alerts/raise-admin-alert';
import { formatWholeCurrency } from '@/lib/utils/currency';
import { trackServerAndFlush, ENGAGEMENT_SERVER_EVENTS } from '@/lib/analytics/server';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import { log } from '@/lib/logging';
import {
  INVALID_REQUEST,
  deriveEngagementTitle,
  formatShortUtc,
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
import { notifyEstimateExceeded } from './time-entry-action-shared';

const approveChangeOrderSchema = z.object({ engagementId: z.uuid(), orderId: z.uuid() }).strict();

/**
 * The client approves a SENT change. Gated on the membership capability
 * `approve_own_proposals`. The repository applies the lines and moves the effective price in
 * one transaction. Fires `CHANGE_ORDER_APPROVED` and publishes `change_order.approved` (the
 * delivering expert with EXPERT figures only, and the Balo admins without amounts). On a
 * fixed-price project, an approval that leaves the final invoice below zero raises a
 * `project.change_order_credit_required` admin alert; T&M never does.
 */
export async function approveChangeOrderAction(input: {
  engagementId: string;
  orderId: string;
}): Promise<EngagementActionResult> {
  const auth = await requireSignedInUser();
  if (!auth.ok) {
    return { success: false, error: auth.error };
  }
  const parsed = approveChangeOrderSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: INVALID_REQUEST };
  }
  const { engagementId, orderId } = parsed.data;
  const { user } = auth;

  return runEngagementLifecycleAction(
    engagementId,
    { userId: user.id, changeOrderId: orderId },
    'Failed to approve change order',
    () => gateChangeOrderClient(user, engagementId, CAPABILITIES.APPROVE_OWN_PROPOSALS),
    async (engagement) => {
      const approval = await engagementChangeOrdersRepository.approve({
        engagementId,
        orderId,
        userId: user.id,
      });
      const { order } = approval;
      const now = new Date();
      const approvedAt = order.decidedAt ?? now;
      const isFixed = engagement.pricingMethod === 'fixed';

      trackServerAndFlush(ENGAGEMENT_SERVER_EVENTS.CHANGE_ORDER_APPROVED, {
        ...changeOrderLinesProps(order, engagement.pricingMethod, user.id),
        days_to_decision: daysToDecision(order, now),
      });

      const parties = deriveEngagementParties(engagement);
      const { currency } = engagement;
      const minutesBefore = engagement.milestones.reduce(
        (sum, milestone) => sum + (milestone.estimatedMinutes ?? 0),
        0
      );
      const minutesDelta = changeOrderMinutesDelta(order.lines);
      const capDeltaCents = approval.effectivePriceCents - approval.previousEffectivePriceCents;
      const newPrice = formatWholeCurrency(approval.effectivePriceCents, currency);
      const expertPriceChangeLabel = isFixed
        ? `${formatWholeCurrency(approval.previousEffectivePriceCents, currency)} → ${newPrice} (${signedMoney(capDeltaCents, currency)})`
        : `Cap ${formatWholeCurrency(approval.previousEffectivePriceCents, currency)} → ${newPrice} (${signedMoney(capDeltaCents, currency)})`;
      const estimateChangeLabel = `${formatHours(minutesBefore)} → ${formatHours(minutesBefore + minutesDelta)} (${signedHours(minutesDelta)})`;

      publishNotificationEvent('change_order.approved', {
        ...payloadBase('approved', order, engagement, parties),
        expertProfileId: engagement.expertProfileId,
        actorClientLabel: personAtCompany(user, parties.clientCompanyName),
        clientCompanyName: parties.clientCompanyName,
        pricingMethod: isFixed ? 'fixed' : 'tm',
        approvedOn: formatShortUtc(approvedAt),
        ...(isFixed ? { expertPriceChangeLabel } : { estimateChangeLabel }),
        ...(!isFixed && capDeltaCents !== 0 ? { expertPriceChangeLabel } : {}),
        expertPartyLabel: parties.expertParty,
      }).catch(() => {
        // publishNotificationEvent logs internally.
      });

      // A T&M raise that time logged since the send already passed: the approval is the crossing.
      for (const milestone of approval.estimatesExceeded) {
        await notifyEstimateExceeded({
          engagement,
          milestone,
          loggedMinutes: milestone.loggedMinutes,
          milestonesOverCount: approval.milestonesOverCount,
          userId: user.id,
        });
      }

      if (isFixed) {
        await raiseCreditAlertIfOwed(engagementId, {
          projectTitle: deriveEngagementTitle(engagement, parties),
          clientCompanyName: parties.clientCompanyName,
          approverLabel: personAtCompany(user, parties.clientCompanyName),
          expertLabel: parties.expertParty,
          approvedOn: formatShortUtc(approvedAt),
        });
      }

      log.info('Change order approved', {
        engagementId,
        changeOrderId: order.id,
        userId: user.id,
        pricing_method: engagement.pricingMethod,
      });
      return { success: true };
    }
  );
}

/**
 * Raise the credit-needed alert when the approved change leaves the final invoice below zero.
 * The approval is already committed, so a failed settlement read is logged and skipped.
 */
async function raiseCreditAlertIfOwed(
  engagementId: string,
  detail: Parameters<typeof buildChangeOrderCreditAlertDetail>[0]
): Promise<void> {
  try {
    const settlement = await loadProjectSettlement(engagementId);
    if (settlement.creditRequiredClientCents > 0) {
      await raiseAdminAlert({
        kind: 'project.change_order_credit_required',
        entityType: 'engagement',
        entityId: engagementId,
        detail: buildChangeOrderCreditAlertDetail(detail),
      });
    }
  } catch (error) {
    log.error('Failed to evaluate change order credit alert', {
      engagementId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  }
}
