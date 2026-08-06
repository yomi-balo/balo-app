'use server';

import 'server-only';

import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  projectEngagementsRepository,
  reviewInviteTokensRepository,
  reviewsRepository,
} from '@balo/db';
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
 * BAL-390 — what the accept email should carry about rating: the RAW magic-link token
 * for the ACCEPTING member, or the fact that they have already rated.
 *
 * ⚠ THE TWO "NO TOKEN" OUTCOMES ARE NOT THE SAME THING, AND THE EMAIL SAYS DIFFERENT
 * THINGS ABOUT THEM, so they are returned as two fields rather than collapsed into one
 * `string | undefined`:
 *   · `{ alreadyRated: true }`  — they rated already ⇒ the email thanks them for it.
 *   · `{ alreadyRated: false }` — the mint FAILED ⇒ the email says nothing at all, because
 *                                 thanking someone for a review they never left is a lie.
 * This is the whole reason `alreadyRated` rides the payload: the template cannot tell the
 * two apart from a missing token, and only this function knows which happened.
 *
 * ⚠ NEVER THROWS, AND MUST NOT. Acceptance is the trigger for the final invoice; a
 * rating token is a nice-to-have riding along with it. A token failure must never break
 * an accept, so the accept has already committed by the time this runs and every failure
 * degrades to "publish without a review block".
 *
 * ⚠ HASHING LIVES HERE, NOT IN `@balo/db`. The repository takes the HASH — no production
 * file under `packages/db/src` imports `node:crypto` — verbatim the `proposal_share_links`
 * web-action contract. The raw token is returned once and is never persisted or logged.
 */
interface ReviewAskFields {
  /** RAW token, or `undefined` ⇒ no star block (already rated, OR the mint failed). */
  readonly reviewToken: string | undefined;
  /** `true` ONLY on a confirmed existing live review — never on a mint failure. */
  readonly alreadyRated: boolean;
}

async function resolveReviewAsk(
  engagementId: string,
  expertProfileId: string,
  reviewerUserId: string
): Promise<ReviewAskFields> {
  try {
    const existing = await reviewsRepository.findLive(
      engagementId,
      reviewerUserId,
      expertProfileId
    );
    if (existing !== undefined) {
      return { reviewToken: undefined, alreadyRated: true };
    }
    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    await reviewInviteTokensRepository.create({ engagementId, reviewerUserId, tokenHash });
    return { reviewToken: rawToken, alreadyRated: false };
  } catch (error) {
    // Never the token itself, and never the hash.
    log.error('Review invite token mint failed', {
      engagementId,
      userId: reviewerUserId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    // NOT `alreadyRated` — we do not know that, and the email must not claim it.
    return { reviewToken: undefined, alreadyRated: false };
  }
}

/**
 * The client ACCEPTS the completed project (pending_acceptance → completed, sticky).
 * Client-lens, capability-based auth + IDOR-safe via {@link gateClientEngagement}, then
 * D0 `acceptCompletion({ method: 'client' })` (FOR UPDATE, `accepted_by` = the acting
 * user, `acceptance_method = 'client'`, audit same tx). Fires `ACCEPTED` (server,
 * method=client) and publishes `engagement.accepted` — the delivering EXPERT (congrats),
 * the Balo ADMINS (the "Ready to invoice: final installment" money trigger) and, since
 * BAL-390, the ACCEPTING MEMBER themselves (their own record of the acceptance with the
 * star-rating ask fused in). Notify is fire-and-forget. The completion is the
 * final-invoice trigger for MJ.
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
      const updated = await projectEngagementsRepository.acceptCompletion({
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
      // BAL-390 adds a THIRD recipient: the accepting member themselves, recipient
      // 'self' via `userId`, MIRRORING `payment.charged` — actor-gets-a-receipt is the
      // house pattern at money moments (`credit.topup.completed`, `promo.redeemed`), and
      // acceptance is the trigger for the final invoice, so the client should hold
      // written evidence of it without logging in. This DELIBERATELY OVERTURNS BAL-338's
      // "No client recipient (they just acted)" ruling, which was the outlier.
      // ⚠ WITHOUT `userId` THE RULE RESOLVES NO RECIPIENT AND THE EMAIL SILENTLY NEVER
      // SENDS (`rules.ts` gates the client arm on it).
      const parties = deriveEngagementParties(engagement);
      const actorClientLabel = personAtCompany(
        { firstName: user.firstName, lastName: user.lastName },
        parties.clientCompanyName
      );
      const { reviewToken, alreadyRated } = await resolveReviewAsk(
        engagementId,
        engagement.expertProfileId,
        user.id
      );
      publishNotificationEvent('engagement.accepted', {
        correlationId: `${engagementId}:accepted`,
        engagementId,
        expertProfileId: engagement.expertProfileId,
        actorClientLabel,
        projectTitle: deriveEngagementTitle(engagement, parties),
        acceptedOn: formatLongUtc(updated.acceptedAt ?? now),
        milestonesTotal: engagement.milestones.length,
        userId: user.id,
        clientCompanyName: parties.clientCompanyName,
        expertPartyLabel: parties.expertParty,
        reviewToken,
        alreadyRated,
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
