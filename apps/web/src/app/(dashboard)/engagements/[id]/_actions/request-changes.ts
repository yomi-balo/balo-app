'use server';

import 'server-only';

import { z } from 'zod';
import { engagementsRepository, AUTO_ACCEPT_DAYS } from '@balo/db';
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
  wholeDaysSince,
  readReviewCycle,
  type EngagementActionResult,
} from './engagement-lifecycle-shared';

// The note is REQUIRED (the repo type requires it; emptiness is validated here at the
// boundary). Trim → reject whitespace-only; cap at 2000 (matches the cancel reason).
const requestChangesSchema = z
  .object({
    engagementId: z.uuid(),
    note: z.string().trim().min(1).max(2000),
  })
  .strict();

/**
 * The client REQUESTS CHANGES instead of accepting (pending_acceptance → active).
 * Client-lens, capability-based auth + IDOR-safe via {@link gateClientEngagement}, then
 * D0 `requestChanges` (→ active, `change_request_note` stored + pinned for the expert
 * until re-request, audit same tx). Dispute is a LOOP, not a parked state — the review
 * window restarts on the next completion request. Fires `CHANGES_REQUESTED` (server) and
 * publishes `engagement.changes_requested` — the delivering EXPERT (email, note verbatim
 * + CTA) + the Balo ADMINS (in-app ops signal). Notify is fire-and-forget.
 */
export async function requestProjectChangesAction(input: {
  engagementId: string;
  note: string;
}): Promise<EngagementActionResult> {
  const auth = await requireSignedInUser();
  if (!auth.ok) {
    return { success: false, error: auth.error };
  }
  const parsed = requestChangesSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: INVALID_REQUEST };
  }
  const { engagementId, note } = parsed.data;
  const { user } = auth;

  return runEngagementLifecycleAction(
    engagementId,
    { userId: user.id },
    'Failed to request changes',
    () => gateClientEngagement(user, engagementId),
    async (engagement) => {
      const updated = await engagementsRepository.requestChanges({
        engagementId,
        userId: user.id,
        note,
      });
      const now = new Date();
      const requestedAt =
        engagement.completionRequestedAt ?? engagement.activatedAt ?? engagement.createdAt;
      const reviewCycle = await readReviewCycle(engagementId);

      trackServerAndFlush(ENGAGEMENT_SERVER_EVENTS.CHANGES_REQUESTED, {
        engagement_id: engagementId,
        days_in_review: wholeDaysSince(requestedAt, now),
        review_cycle: reviewCycle,
        distinct_id: user.id,
      });

      // ── Notify (fire-and-forget) — delivering expert (note verbatim) + admins ──
      // The note is NEVER logged (free-text) — it travels only in the notification
      // payload to the expert who needs to act on it.
      const parties = deriveEngagementParties(engagement);
      const actorClientLabel = personAtCompany(
        { firstName: user.firstName, lastName: user.lastName },
        parties.clientCompanyName
      );
      const changeRequestedAt = updated.changeRequestedAt ?? now;
      publishNotificationEvent('engagement.changes_requested', {
        correlationId: `${engagementId}:changes_requested:${changeRequestedAt.getTime()}`,
        engagementId,
        expertProfileId: engagement.expertProfileId,
        actorClientLabel,
        projectTitle: deriveEngagementTitle(engagement, parties),
        note,
        reviewDays: AUTO_ACCEPT_DAYS,
        reviewCycle,
      }).catch(() => {
        // publishNotificationEvent logs internally.
      });

      log.info('Engagement changes requested', {
        engagementId,
        userId: user.id,
        review_cycle: reviewCycle,
      });
      return { success: true };
    }
  );
}
