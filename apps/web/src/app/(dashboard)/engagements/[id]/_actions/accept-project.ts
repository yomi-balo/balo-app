'use server';

import 'server-only';

import { z } from 'zod';
import { engagementsRepository } from '@balo/db';
import { deriveEngagementParties, personAtCompany } from '@/lib/engagement/engagement-parties';
import { trackServerAndFlush, ENGAGEMENT_SERVER_EVENTS } from '@/lib/analytics/server';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import { log } from '@/lib/logging';
import {
  INVALID_REQUEST,
  deriveEngagementTitle,
  requireSignedInUser,
  gateClientEngagement,
  runEngagementLifecycleAction,
  formatLongUtc,
  wholeDaysSince,
  readReviewCycle,
  type EngagementActionResult,
} from './engagement-lifecycle-shared';

const acceptProjectSchema = z.object({ engagementId: z.uuid() }).strict();

/**
 * The client ACCEPTS the completed project (pending_acceptance → completed, sticky).
 * Client-lens, capability-based auth + IDOR-safe via {@link gateClientEngagement}, then
 * D0 `acceptCompletion({ method: 'client' })` (FOR UPDATE, `accepted_by` = the acting
 * user, `acceptance_method = 'client'`, audit same tx). Fires `ACCEPTED` (server,
 * method=client) and publishes `engagement.accepted` — the delivering EXPERT (congrats)
 * + the Balo ADMINS (the "Ready to invoice: final installment" money trigger). Notify
 * is fire-and-forget. The completion is the final-invoice trigger for MJ.
 */
export async function acceptProjectAction(input: {
  engagementId: string;
}): Promise<EngagementActionResult> {
  const auth = await requireSignedInUser();
  if (!auth.ok) {
    return { success: false, error: auth.error };
  }
  const parsed = acceptProjectSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: INVALID_REQUEST };
  }
  const { engagementId } = parsed.data;
  const { user } = auth;

  return runEngagementLifecycleAction(
    engagementId,
    { userId: user.id },
    'Failed to accept project',
    () => gateClientEngagement(user, engagementId),
    async (engagement) => {
      const updated = await engagementsRepository.acceptCompletion({
        engagementId,
        method: 'client',
        userId: user.id,
      });
      const now = new Date();
      const requestedAt =
        engagement.completionRequestedAt ?? engagement.activatedAt ?? engagement.createdAt;
      const reviewCycle = await readReviewCycle(engagementId);

      trackServerAndFlush(ENGAGEMENT_SERVER_EVENTS.ACCEPTED, {
        engagement_id: engagementId,
        acceptance_method: 'client',
        days_in_review: wholeDaysSince(requestedAt, now),
        review_cycle: reviewCycle,
        distinct_id: user.id,
      });

      // ── Notify (fire-and-forget) — delivering expert (congrats) + admins (money) ──
      const parties = deriveEngagementParties(engagement);
      const actorClientLabel = personAtCompany(
        { firstName: user.firstName, lastName: user.lastName },
        parties.clientCompanyName
      );
      publishNotificationEvent('engagement.accepted', {
        correlationId: `${engagementId}:accepted`,
        engagementId,
        expertProfileId: engagement.expertProfileId,
        actorClientLabel,
        projectTitle: deriveEngagementTitle(engagement, parties),
        acceptedOn: formatLongUtc(updated.acceptedAt ?? now),
        milestonesTotal: engagement.milestones.length,
      }).catch(() => {
        // publishNotificationEvent logs internally.
      });

      log.info('Engagement accepted', {
        engagementId,
        userId: user.id,
        review_cycle: reviewCycle,
      });
      return { success: true };
    }
  );
}
