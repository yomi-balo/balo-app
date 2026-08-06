import 'server-only';

import { engagementsRepository, reviewsRepository } from '@balo/db';
import {
  resolveEndOfCallReviewState,
  type EndOfCallReviewState,
  type Rating,
  parsePrefillRating,
} from '@balo/shared/reviews';

/**
 * readEngagementReview — the END-OF-CALL READ (BAL-390 D3).
 *
 * Composes `reviewsRepository.findLive` with the PURE
 * `resolveEndOfCallReviewState` so the "below 4 is a warm re-ask" boundary is
 * decided in exactly one place. BAL-389 mounts the surface and calls this; BAL-390
 * ships the reader with tests and NO caller.
 *
 * ⚠ NO AUTHORIZATION HERE, AND NONE IS NEEDED. The read is keyed on the VIEWER's own
 * user id, so it can only ever return the viewer's own review — it reveals nothing
 * about anybody else and cannot be an existence oracle beyond what the caller already
 * knows. The WRITE path is where the capability gate lives (`applyReview`).
 *
 * ⚠ EXPLICIT PROJECTION. The `reviews` row is never returned wholesale: a client
 * component receives the rating, the body and a date, and nothing else.
 */

export interface EngagementReviewRead {
  /** The viewer's own live review of this engagement's expert, projected for display. */
  review: { rating: Rating; body: string | null; ratedOnIso: string } | null;
  /** The three-state end-of-call resolution derived from that review. */
  state: EndOfCallReviewState;
}

/**
 * The viewer's review of `engagementId`'s delivering expert, plus its end-of-call state.
 *
 * Returns `undefined` when the engagement does not exist or is soft-deleted — a
 * genuinely absent engagement is a different thing from "no review yet", and collapsing
 * the two would make the caller render a rating prompt for nothing.
 */
export async function readEngagementReview(
  engagementId: string,
  viewerUserId: string
): Promise<EngagementReviewRead | undefined> {
  const engagement = await engagementsRepository.findById(engagementId);
  if (engagement === undefined) {
    return undefined;
  }

  const existing = await reviewsRepository.findLive(
    engagementId,
    viewerUserId,
    engagement.expertProfileId
  );
  if (existing === undefined) {
    return { review: null, state: resolveEndOfCallReviewState(null) };
  }

  // `reviews.rating` is an integer column fenced by the DB CHECK `review_rating_range`,
  // so this narrowing is total in practice; `null` would only mean a row wrote around
  // the constraint, and the resolver's "no review" branch is the safe reading of that.
  const rating = parsePrefillRating(String(existing.rating));
  if (rating === null) {
    return { review: null, state: resolveEndOfCallReviewState(null) };
  }

  return {
    review: {
      rating,
      body: existing.body,
      ratedOnIso: (existing.lastEditedAt ?? existing.createdAt).toISOString(),
    },
    state: resolveEndOfCallReviewState(rating),
  };
}
