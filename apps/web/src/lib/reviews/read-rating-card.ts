import 'server-only';

import { meetingContextsRepository } from '@balo/db';
import { log } from '@/lib/logging';
import type { EndOfCallRatingView } from '@/lib/meetings/end-of-call-view-types';
import { readEngagementReview } from './read-engagement-review';

/**
 * The single read behind all three in-app rating-card placements (the project
 * workspace, the case rail, the recap wrap-up). Wraps `readEngagementReview` with the
 * same never-consulted gate the review-nudge sweep uses, so a card is never shown asking
 * about a consultation that didn't happen.
 *
 * ⚠⚠ REUSES THE SWEEP'S CHECK VERBATIM — `lastCompletedConsultationAt instanceof Date`,
 * read off `meetingContextsRepository.consultationTimestampsForEngagements` (the same seam
 * `apps/api/src/jobs/review-nudge-sweep.ts` calls). No second definition of "consulted" is
 * written here. `requireHeldConsultation` applies the gate to EVERY closed case — `resolved`
 * AND `auto_inactive` alike, since a `resolved` case-surface close can still have zero held
 * consultations.
 *
 * ⚠⚠ NEVER COMPARES AGAINST THE RATING THRESHOLD. `state` is passed through untouched from
 * `readEngagementReview` → `resolveEndOfCallReviewState`; the "below 4 is a warm re-ask"
 * boundary is decided exactly once, there.
 *
 * ⚠⚠ DEGRADES, NEVER BLOCKS. The whole read is wrapped in try/catch — a review-read fault
 * must never break an otherwise-successful completed project, closed case or recap render.
 * On any thrown error this logs and returns `null`, exactly like an ordinary "nothing to
 * rate" outcome; callers cannot and must not distinguish the two.
 *
 * ⚠ `engagementId` IS `meeting_contexts.context_id`, WHICH CARRIES NO FK. Callers must pass
 * an id their own loader has already authorized the viewer against — this function performs
 * no authorization of its own (mirrors `readEngagementReview`'s own docblock: the read is
 * keyed on the viewer's own review and reveals nothing else).
 */
export async function readRatingCard(input: {
  engagementId: string;
  viewerUserId: string;
  requireHeldConsultation: boolean;
  now: Date;
}): Promise<EndOfCallRatingView | null> {
  const { engagementId, viewerUserId, requireHeldConsultation, now } = input;
  try {
    const [engagementReview, timestamps] = await Promise.all([
      readEngagementReview(engagementId, viewerUserId),
      requireHeldConsultation
        ? meetingContextsRepository.consultationTimestampsForEngagements([engagementId], now)
        : Promise.resolve(null),
    ]);

    if (engagementReview === undefined) {
      return null;
    }

    if (
      requireHeldConsultation &&
      !(timestamps?.get(engagementId)?.lastCompletedConsultationAt instanceof Date)
    ) {
      return null;
    }

    return {
      engagementId,
      state: engagementReview.state,
      existingBody: engagementReview.review?.body ?? null,
    };
  } catch (error) {
    log.error('Rating card read failed', {
      engagementId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return null;
  }
}
