'use server';

import 'server-only';

import { z } from 'zod';
import { engagementsRepository } from '@balo/db';
import { deriveEngagementParties } from '@/lib/engagement/engagement-parties';
import { trackServerAndFlush, ENGAGEMENT_SERVER_EVENTS } from '@/lib/analytics/server';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import { log } from '@/lib/logging';
import {
  HOUR_MS,
  INVALID_REQUEST,
  deriveEngagementTitle,
  requireSignedInUser,
  resolveClientRecipientId,
  gateExpertEngagement,
  runEngagementLifecycleAction,
  type EngagementActionResult,
} from './engagement-lifecycle-shared';

const withdrawSchema = z.object({ engagementId: z.uuid() }).strict();

/**
 * The delivering expert withdraws a pending completion request (pending_acceptance →
 * active), taking the project back out of the client's review. Auth/lens/status via
 * {@link gateExpertEngagement} (`pending_acceptance` → wrong status yields
 * NOT_UNDER_REVIEW), then `engagementsRepository.withdrawCompletionRequest` (D0 clears
 * the completion-request stamps). Fires `COMPLETION_WITHDRAWN` (server) and publishes
 * `engagement.completion_withdrawn` (client owner + admins, in-app only) —
 * fire-and-forget. `hours_in_review` is captured from the PRE-withdraw
 * `completionRequestedAt` (D0 clears it during the call).
 */
export async function withdrawCompletionRequestAction(input: {
  engagementId: string;
}): Promise<EngagementActionResult> {
  const auth = await requireSignedInUser();
  if (!auth.ok) {
    return { success: false, error: auth.error };
  }
  const parsed = withdrawSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: INVALID_REQUEST };
  }
  const { engagementId } = parsed.data;
  const { user } = auth;

  return runEngagementLifecycleAction(
    engagementId,
    { userId: user.id },
    'Failed to withdraw completion request',
    () => gateExpertEngagement(user, engagementId, 'pending_acceptance'),
    async (engagement) => {
      // Capture BEFORE the call — D0's withdraw clears `completionRequestedAt` to null.
      const requestedAt = engagement.completionRequestedAt;
      await engagementsRepository.withdrawCompletionRequest({ engagementId, userId: user.id });
      const nowMs = Date.now();

      const hoursInReview =
        requestedAt === null
          ? 0
          : Math.max(0, Math.floor((nowMs - requestedAt.getTime()) / HOUR_MS));
      trackServerAndFlush(ENGAGEMENT_SERVER_EVENTS.COMPLETION_WITHDRAWN, {
        engagement_id: engagementId,
        hours_in_review: hoursInReview,
        distinct_id: user.id,
      });

      // ── Notify (fire-and-forget) — client owner + admins, in-app only ──
      const parties = deriveEngagementParties(engagement);
      const recipientId = await resolveClientRecipientId(engagement.company.id);
      publishNotificationEvent('engagement.completion_withdrawn', {
        correlationId: `${engagementId}:completion_withdrawn:${nowMs}`,
        engagementId,
        recipientId,
        actorExpertLabel: parties.expertRetroFirstMention,
        projectTitle: deriveEngagementTitle(engagement, parties),
      }).catch(() => {
        // publishNotificationEvent logs internally.
      });

      log.info('Completion request withdrawn', { engagementId, userId: user.id });
      return { success: true };
    }
  );
}
