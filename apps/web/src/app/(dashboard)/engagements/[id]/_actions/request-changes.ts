'use server';

import 'server-only';

import { z } from 'zod';
import {
  projectEngagementsRepository,
  ChangeRequestMilestoneMismatchError,
  AUTO_ACCEPT_DAYS,
} from '@balo/db';
import { isRepeatChangeRequestRound } from '@balo/shared/engagements';
import { deriveEngagementParties, personAtCompany } from '@/lib/engagement/engagement-parties';
import { trackServerAndFlush, ENGAGEMENT_SERVER_EVENTS } from '@/lib/analytics/server';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import { log } from '@/lib/logging';
import { raiseAdminAlert } from '@/lib/admin-alerts/raise-admin-alert';
import { buildRepeatChangeRequestAlertDetail } from '@/lib/engagement/repeat-change-request-alert';
import { PLAN_CHANGED } from './milestone-action-shared';
import {
  INVALID_REQUEST,
  deriveEngagementTitle,
  requireSignedInUser,
  gateClientEngagement,
  runEngagementLifecycleAction,
  wholeDaysSince,
  formatShortUtc,
  readReviewCycle,
  type EngagementActionResult,
} from './engagement-lifecycle-shared';

// The note is REQUIRED (the repo type requires it; emptiness is validated here at the
// boundary). Trim → reject whitespace-only; cap at 2000 (matches the cancel reason).
// `milestoneIds` tags the milestones the feedback is about; absent or empty = untagged.
// Duplicates collapse here, and the repository re-verifies each id is a live milestone
// of this engagement under its lock.
const requestChangesSchema = z
  .object({
    engagementId: z.uuid(),
    note: z.string().trim().min(1).max(2000),
    milestoneIds: z
      .array(z.uuid())
      .max(100)
      .optional()
      .transform((ids) => [...new Set(ids ?? [])]),
  })
  .strict();

/**
 * The client REQUESTS CHANGES instead of accepting (pending_acceptance → active).
 * Client-lens, capability-based auth + IDOR-safe via {@link gateClientEngagement}, then
 * `requestChanges`, which writes one durable round (the note, the optional tagged
 * milestones — completed ones reopen — and the audit, in one transaction). A tagged id
 * that is no longer a live milestone of this project maps to `PLAN_CHANGED` and nothing
 * is written. Dispute is a LOOP, not a parked state — the review window restarts on the
 * next completion request. Fires `CHANGES_REQUESTED` (server) and publishes
 * `engagement.changes_requested` — the delivering EXPERT (email, note verbatim + tagged
 * titles + CTA) + the Balo ADMINS (in-app ops signal). From the second round on, it also
 * raises a `project.repeat_change_request` admin alert. Notify and alert are
 * best-effort: neither can fail the request.
 */
export async function requestProjectChangesAction(input: {
  engagementId: string;
  note: string;
  milestoneIds?: readonly string[];
}): Promise<EngagementActionResult> {
  const auth = await requireSignedInUser();
  if (!auth.ok) {
    return { success: false, error: auth.error };
  }
  const parsed = requestChangesSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: INVALID_REQUEST };
  }
  const { engagementId, note, milestoneIds } = parsed.data;
  const { user } = auth;

  return runEngagementLifecycleAction(
    engagementId,
    { userId: user.id },
    'Failed to request changes',
    () => gateClientEngagement(user, engagementId),
    async (engagement) => {
      let updated: Awaited<ReturnType<typeof projectEngagementsRepository.requestChanges>>;
      try {
        updated = await projectEngagementsRepository.requestChanges({
          engagementId,
          userId: user.id,
          note,
          milestoneIds,
        });
      } catch (error) {
        if (error instanceof ChangeRequestMilestoneMismatchError) {
          return { success: false, error: PLAN_CHANGED };
        }
        throw error; // → the shared GENERIC_FAILURE boundary
      }
      const { roundNumber, taggedMilestones } = updated.changeRequest;
      const taggedMilestoneTitles = taggedMilestones.map((milestone) => milestone.title);
      const now = new Date();
      const requestedAt =
        engagement.completionRequestedAt ?? engagement.activatedAt ?? engagement.createdAt;
      const reviewCycle = await readReviewCycle(engagementId);

      trackServerAndFlush(ENGAGEMENT_SERVER_EVENTS.CHANGES_REQUESTED, {
        engagement_id: engagementId,
        days_in_review: wholeDaysSince(requestedAt, now),
        review_cycle: reviewCycle,
        round_number: roundNumber,
        tagged_milestone_count: taggedMilestones.length,
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
        actorUserId: user.id,
        deliveringExpertName: parties.expertPerson,
        projectTitle: deriveEngagementTitle(engagement, parties),
        note,
        reviewDays: AUTO_ACCEPT_DAYS,
        reviewCycle,
        roundNumber,
        taggedMilestoneTitles,
      }).catch(() => {
        // publishNotificationEvent logs internally.
      });

      // A repeat round tells the Balo team the project may need a check-in. Best-effort:
      // `raiseAdminAlert` swallows its own failure, so the client's request always lands.
      if (isRepeatChangeRequestRound(roundNumber)) {
        await raiseAdminAlert({
          kind: 'project.repeat_change_request',
          entityType: 'engagement',
          entityId: engagementId,
          detail: buildRepeatChangeRequestAlertDetail({
            projectTitle: deriveEngagementTitle(engagement, parties),
            clientCompanyName: parties.clientCompanyName,
            actorClientLabel,
            expertLabel: parties.expertParty,
            roundNumber,
            taggedMilestoneTitles,
            requestedOn: formatShortUtc(changeRequestedAt),
          }),
        });
      }

      log.info('Engagement changes requested', {
        engagementId,
        userId: user.id,
        review_cycle: reviewCycle,
        round_number: roundNumber,
        tagged_milestone_count: taggedMilestones.length,
      });
      return { success: true };
    }
  );
}
