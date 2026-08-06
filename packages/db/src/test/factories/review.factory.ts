import { randomBytes, createHash } from 'node:crypto';
import { db } from '../../client';
import { reviews, reviewInviteTokens } from '../../schema';
import type { NewReview, NewReviewInviteToken, Review, ReviewInviteToken } from '../../schema';
import { companyMemberFactory } from './company.factory';
import { engagementFactory, type EngagementFactoryResult } from './engagement.factory';
import { userFactory } from './user.factory';

/**
 * BAL-390 fixtures. Both factories insert DIRECTLY via `db` rather than through their
 * repositories (the `proposal-share-link.factory` / `case-engagement.factory`
 * precedent) so a test can force states the write paths refuse to produce — a revoked
 * or expired token, a soft-deleted review, an `expert_profile_id` that disagrees with
 * the engagement. There is no `.create(tx, …)` namespace anywhere in this codebase;
 * do not invent one.
 */

/**
 * Resolve the (engagement, reviewer) pair both factories start from: a fresh live PROJECT
 * engagement unless one is supplied, and a reviewer holding a LIVE `company_members` row
 * on that engagement's company unless an id is supplied.
 *
 * The membership matters: `PARTICIPATE` is what the web layer resolves at submit time, so
 * a fixture reviewer without one would make every downstream authorization test vacuous.
 */
async function resolveEngagementAndReviewer(overrides: {
  engagement?: EngagementFactoryResult;
  reviewerUserId?: string;
}): Promise<{ engagement: EngagementFactoryResult; reviewerUserId: string }> {
  const engagement = overrides.engagement ?? (await engagementFactory());

  if (overrides.reviewerUserId !== undefined) {
    return { engagement, reviewerUserId: overrides.reviewerUserId };
  }

  const reviewer = await userFactory();
  await companyMemberFactory({ companyId: engagement.companyId, userId: reviewer.id });
  return { engagement, reviewerUserId: reviewer.id };
}

interface ReviewFactoryOverrides {
  /** Reuse an existing engagement instead of seeding a fresh live project. */
  engagement?: EngagementFactoryResult;
  /** The reviewing person. Defaults to a fresh user with a LIVE membership of the client company. */
  reviewerUserId?: string;
  /** Row-level overrides (rating, body, surface, authMethod, deletedAt, expertProfileId, …). */
  values?: Partial<NewReview>;
}

export interface ReviewFactoryResult {
  review: Review;
  engagementId: string;
  reviewerUserId: string;
  expertProfileId: string;
}

/**
 * Seeds one live `reviews` row over a fresh PROJECT engagement.
 *
 * The reviewer is seeded with a LIVE `company_members` row on the engagement's company,
 * because that is the shape the capability gate (`PARTICIPATE`) resolves against at the
 * web layer — a fixture without it would make every downstream authorization test
 * vacuous. `expertProfileId` defaults to the ENGAGEMENT'S expert; overriding it to
 * anything else is how the `review_engagement_expert_fk` coherence test forces a 23503.
 */
export async function reviewFactory(
  overrides: ReviewFactoryOverrides = {}
): Promise<ReviewFactoryResult> {
  const { engagement, reviewerUserId } = await resolveEngagementAndReviewer(overrides);
  const engagementId = engagement.engagement.id;
  const expertProfileId = overrides.values?.expertProfileId ?? engagement.expertProfileId;

  const [review] = await db
    .insert(reviews)
    .values({
      engagementId,
      reviewerUserId,
      expertProfileId,
      rating: 5,
      body: null,
      surface: 'end_of_call',
      authMethod: 'session',
      ...overrides.values,
    })
    .returning();
  if (review === undefined) {
    throw new Error('review insert failed');
  }

  return { review, engagementId, reviewerUserId, expertProfileId };
}

interface ReviewInviteTokenFactoryOverrides {
  /** Reuse an existing engagement instead of seeding a fresh live project. */
  engagement?: EngagementFactoryResult;
  /** The token's subject. Defaults to a fresh user with a LIVE membership of the client company. */
  reviewerUserId?: string;
  /**
   * Row-level overrides (expiresAt, revokedAt, deletedAt, accessCount, …).
   *
   * ⚠ Passing `values.tokenHash` DECOUPLES the returned `rawToken` from the stored hash
   * — deliberately available (a "wrong token" fixture needs it), but never do it by
   * accident: the returned `rawToken` would then resolve nothing.
   */
  values?: Partial<NewReviewInviteToken>;
}

export interface ReviewInviteTokenFactoryResult {
  token: ReviewInviteToken;
  /**
   * The RAW token — returned so landing/submit tests exercise a REAL hash lookup rather
   * than reading `token.tokenHash` back out and thereby testing nothing. Production never
   * gets a second chance at this value; the fixture does, because it minted it.
   */
  rawToken: string;
  engagementId: string;
  reviewerUserId: string;
}

/**
 * Seeds one `review_invite_tokens` row over a fresh PROJECT engagement, hashing the raw
 * token exactly as the production caller does (`sha256(raw).hex` — the hashing lives in
 * the CALLER, never in `@balo/db`).
 */
export async function reviewInviteTokenFactory(
  overrides: ReviewInviteTokenFactoryOverrides = {}
): Promise<ReviewInviteTokenFactoryResult> {
  const { engagement, reviewerUserId } = await resolveEngagementAndReviewer(overrides);
  const engagementId = engagement.engagement.id;

  const rawToken = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');

  const [token] = await db
    .insert(reviewInviteTokens)
    .values({
      engagementId,
      reviewerUserId,
      tokenHash,
      ...overrides.values,
    })
    .returning();
  if (token === undefined) {
    throw new Error('review invite token insert failed');
  }

  return { token, rawToken, engagementId, reviewerUserId };
}
