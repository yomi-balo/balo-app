'use server';

import 'server-only';

import { z } from 'zod';
import {
  engagementsRepository,
  proposalsRepository,
  AUTO_ACCEPT_DAYS,
  type EngagementWithMilestones,
} from '@balo/db';
import { deriveEngagementParties } from '@/lib/engagement/engagement-parties';
import { trackServerAndFlush, ENGAGEMENT_SERVER_EVENTS } from '@/lib/analytics/server';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import { log } from '@/lib/logging';
import {
  DAY_MS,
  INVALID_REQUEST,
  deriveEngagementTitle,
  requireSignedInUser,
  resolveClientRecipientId,
  gateExpertEngagement,
  runEngagementLifecycleAction,
  formatShortUtc,
  wholeDaysSince,
  readReviewCycle,
  type EngagementActionResult,
} from './engagement-lifecycle-shared';

const requestCompletionSchema = z.object({ engagementId: z.uuid() }).strict();

/**
 * Best-effort `proposed_timeframe_weeks` — the source proposal's `timeframeWeeks`
 * (the "~N weeks" the expert proposed), tolerating a retainer / missing proposal
 * (→ null). Wrapped so a read hiccup degrades to null rather than failing the action.
 */
async function readProposedTimeframeWeeks(
  engagement: EngagementWithMilestones
): Promise<number | null> {
  try {
    if (engagement.sourceProposalId === null) {
      return null;
    }
    const proposal = await proposalsRepository.findById(engagement.sourceProposalId);
    return proposal?.timeframeWeeks ?? null;
  } catch {
    return null;
  }
}

/**
 * The delivering expert marks the WHOLE project complete (active → pending_acceptance),
 * sending it for the client's review. Auth/lens/status via {@link gateExpertEngagement}
 * (`active`), then `engagementsRepository.requestCompletion` (D0 hard-enforces the
 * all-live-milestones-complete guard under its lock; a ZERO-milestone engagement passes
 * vacuously). Fires `COMPLETION_REQUESTED` (server) and publishes
 * `engagement.completion_requested` (client owner email + in-app; admins in-app) —
 * fire-and-forget.
 */
export async function requestCompletionAction(input: {
  engagementId: string;
}): Promise<EngagementActionResult> {
  const auth = await requireSignedInUser();
  if (!auth.ok) {
    return { success: false, error: auth.error };
  }
  const parsed = requestCompletionSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: INVALID_REQUEST };
  }
  const { engagementId } = parsed.data;
  const { user } = auth;

  return runEngagementLifecycleAction(
    engagementId,
    { userId: user.id },
    'Failed to request completion',
    () => gateExpertEngagement(user, engagementId, 'active'),
    async (engagement) => {
      const updated = await engagementsRepository.requestCompletion({
        engagementId,
        userId: user.id,
      });
      const now = new Date();

      // Two independent best-effort reads (each guards itself, degrading to its
      // own safe default) — run concurrently to drop the sequential round-trip.
      const [reviewCycle, proposedTimeframeWeeks] = await Promise.all([
        readReviewCycle(engagementId),
        readProposedTimeframeWeeks(engagement),
      ]);
      trackServerAndFlush(ENGAGEMENT_SERVER_EVENTS.COMPLETION_REQUESTED, {
        engagement_id: engagementId,
        days_since_kickoff: wholeDaysSince(engagement.activatedAt ?? engagement.createdAt, now),
        proposed_timeframe_weeks: proposedTimeframeWeeks,
        milestones_total: engagement.milestones.length,
        review_cycle: reviewCycle,
        distinct_id: user.id,
      });

      // ── Notify (fire-and-forget) — client company owner (email + in-app) + admins ──
      const parties = deriveEngagementParties(engagement);
      const recipientId = await resolveClientRecipientId(engagement.company.id);
      const requestedAt = updated.completionRequestedAt ?? now;
      const autoOn = new Date(requestedAt.getTime() + AUTO_ACCEPT_DAYS * DAY_MS);
      publishNotificationEvent('engagement.completion_requested', {
        correlationId: `${engagementId}:completion_requested:${requestedAt.getTime()}`,
        engagementId,
        recipientId,
        clientCompanyName: parties.clientCompanyName,
        expertPartyLabel: parties.expertParty,
        actorExpertLabel: parties.expertRetroFirstMention,
        projectTitle: deriveEngagementTitle(engagement, parties),
        milestonesTotal: engagement.milestones.length,
        requestedDate: formatShortUtc(requestedAt),
        autoDate: formatShortUtc(autoOn),
        reviewDays: AUTO_ACCEPT_DAYS,
      }).catch(() => {
        // publishNotificationEvent logs internally.
      });

      log.info('Completion requested', {
        engagementId,
        userId: user.id,
        review_cycle: reviewCycle,
      });
      return { success: true };
    }
  );
}
