import 'server-only';

import {
  companiesRepository,
  engagementsRepository,
  reviewsRepository,
  usersRepository,
} from '@balo/db';
import {
  isCompanyNameAllowedOnReviews,
  resolveCaptureDefaults,
  resolveEndOfCallReviewState,
  type EndOfCallReviewState,
  type Rating,
  type ReviewCaptureSeeds,
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
 * ⚠ NO AUTHORIZATION HERE — THE CALLER MUST HAVE AUTHORIZED THE VIEWER AGAINST THE
 * ENGAGEMENT. The review itself is keyed on the VIEWER's own user id, but `capture` reads
 * the engagement's company name, industry and hidden flag by `engagementId` alone, so an
 * unauthorized caller would get another company's details. Every caller gates on the client
 * lens first, as `read-rating-card.ts` does. The WRITE path has its own capability gate
 * (`applyReview`).
 *
 * ⚠ EXPLICIT PROJECTION. The `reviews` row is never returned wholesale: a client
 * component receives the rating, the body and a date, and nothing else.
 *
 * BAL-628 — it ALSO returns `capture`, the ONE seam that seeds the attribution controls on
 * every in-app rating surface: who the reviewer is (first name + surname initial), the
 * company and its industry, whether the company name may appear on reviews, and the initial
 * values of the role / company / note-visibility controls. It FAILS CLOSED: an unreadable
 * reviewer or company yields null names and `companyNameAllowed: false`, never a guess.
 */

export interface EngagementReviewRead {
  /** The viewer's own live review of this engagement's expert, projected for display. */
  review: { rating: Rating; body: string | null; ratedOnIso: string } | null;
  /** The three-state end-of-call resolution derived from that review. */
  state: EndOfCallReviewState;
  /** Seeds for the reviewer-attribution controls (BAL-628). */
  capture: ReviewCaptureSeeds;
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

  const [existing, reviewer, company, lastShowCompany] = await Promise.all([
    reviewsRepository.findLive(engagementId, viewerUserId, engagement.expertProfileId),
    usersRepository.findReviewerIdentityById(viewerUserId),
    companiesRepository.findReviewAttributionById(engagement.companyId),
    reviewsRepository.findLatestShowCompanyChoice(viewerUserId),
  ]);

  // `reviews.rating` is an integer fenced by the DB CHECK `review_rating_range`, so this
  // narrowing is total in practice. A stored rating outside 1–5 would mean a row wrote around
  // that CHECK; it is read as "no review", for the capture defaults too.
  const rating = existing === undefined ? null : parsePrefillRating(String(existing.rating));
  const liveReview = existing !== undefined && rating !== null ? existing : null;

  const capture: ReviewCaptureSeeds = {
    identity: {
      engagementKind: engagement.engagementType === 'case' ? 'case' : 'project',
      reviewerFirstName: reviewer?.firstName ?? null,
      reviewerLastInitial: reviewer?.lastInitial ?? null,
      companyName: company?.name ?? null,
      companyNameAllowed: company !== undefined && isCompanyNameAllowedOnReviews(company),
      industryName: company?.industryName ?? null,
    },
    defaults: resolveCaptureDefaults({
      existing:
        liveReview === null
          ? null
          : {
              reviewerRole: liveReview.reviewerRole,
              showCompany: liveReview.showCompany,
              bodyVisibility: liveReview.bodyVisibility,
            },
      jobTitle: reviewer?.jobTitle ?? null,
      lastShowCompany: lastShowCompany ?? null,
    }),
  };

  if (liveReview === null || rating === null) {
    return { review: null, state: resolveEndOfCallReviewState(null), capture };
  }

  return {
    review: {
      rating,
      body: liveReview.body,
      ratedOnIso: (liveReview.lastEditedAt ?? liveReview.createdAt).toISOString(),
    },
    state: resolveEndOfCallReviewState(rating),
    capture,
  };
}
