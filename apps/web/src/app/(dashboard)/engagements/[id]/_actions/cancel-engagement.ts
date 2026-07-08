'use server';

import 'server-only';

import { z } from 'zod';
import { engagementsRepository } from '@balo/db';
import { deriveEngagementParties } from '@/lib/engagement/engagement-parties';
import { trackServerAndFlush, ENGAGEMENT_SERVER_EVENTS } from '@/lib/analytics/server';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import { log } from '@/lib/logging';
import {
  INVALID_REQUEST,
  deriveEngagementTitle,
  requireSignedInUser,
  resolveClientRecipientId,
  gateAdminEngagement,
  runEngagementLifecycleAction,
  formatLongUtc,
  wholeDaysSince,
  type EngagementActionResult,
} from './engagement-lifecycle-shared';

const cancelSchema = z
  .object({
    engagementId: z.uuid(),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();

/**
 * Balo (admin) cancels an engagement (active | pending_acceptance → cancelled),
 * ending delivery permanently. Auth/lens/status via {@link gateAdminEngagement} (admin
 * observer lens; terminal engagement → ENGAGEMENT_CLOSED). A non-empty `reason` is
 * required (the client also disables submit until non-empty). Then
 * `engagementsRepository.cancelEngagement` (D0 captures the `from` status under its
 * lock). Fires `CANCELLED` (server) and publishes `engagement.cancelled` (client owner
 * + delivering expert, email + in-app) — fire-and-forget. No admin notification (the
 * admin is the actor).
 */
export async function cancelEngagementAction(input: {
  engagementId: string;
  reason: string;
}): Promise<EngagementActionResult> {
  const auth = await requireSignedInUser();
  if (!auth.ok) {
    return { success: false, error: auth.error };
  }
  const parsed = cancelSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: INVALID_REQUEST };
  }
  const { engagementId, reason } = parsed.data;
  const { user } = auth;

  return runEngagementLifecycleAction(
    engagementId,
    { userId: user.id },
    'Failed to cancel engagement',
    () => gateAdminEngagement(user, engagementId),
    async (engagement) => {
      // The gate guarantees status ∈ {active, pending_acceptance}; narrow to the
      // analytics literal for the `status_at_cancel` dimension.
      const statusAtCancel =
        engagement.status === 'pending_acceptance' ? 'pending_acceptance' : 'active';
      await engagementsRepository.cancelEngagement({ engagementId, userId: user.id, reason });
      const now = new Date();

      trackServerAndFlush(ENGAGEMENT_SERVER_EVENTS.CANCELLED, {
        engagement_id: engagementId,
        status_at_cancel: statusAtCancel,
        days_since_kickoff: wholeDaysSince(engagement.activatedAt ?? engagement.createdAt, now),
        milestones_completed: engagement.milestones.filter((m) => m.status === 'completed').length,
        milestones_total: engagement.milestones.length,
        distinct_id: user.id,
      });

      // ── Notify (fire-and-forget) — client owner + delivering expert (email + in-app) ──
      const parties = deriveEngagementParties(engagement);
      const recipientId = await resolveClientRecipientId(engagement.company.id);
      publishNotificationEvent('engagement.cancelled', {
        correlationId: `${engagementId}:cancelled`,
        engagementId,
        recipientId,
        expertProfileId: engagement.expertProfile.id,
        projectTitle: deriveEngagementTitle(engagement, parties),
        cancelledOn: formatLongUtc(now),
        reason,
      }).catch(() => {
        // publishNotificationEvent logs internally.
      });

      log.info('Engagement cancelled', {
        engagementId,
        userId: user.id,
        status_at_cancel: statusAtCancel,
      });
      return { success: true };
    }
  );
}
