import { describe, it, expect } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import { auditEvents, expertProfiles, reviews } from '../schema';
import type { AuditEvent } from '../schema';
import {
  caseEngagementFactory,
  companyMemberFactory,
  engagementFactory,
  expertDraftFactory,
  reviewFactory,
  userFactory,
  type EngagementFactoryResult,
} from '../test/factories';
import { reviewsRepository, type UpsertReviewInput } from './reviews';

/** A fresh engagement plus a member of its client company — the canonical reviewer shape. */
async function seedEngagementAndReviewer(): Promise<{
  engagement: EngagementFactoryResult;
  reviewerUserId: string;
}> {
  const engagement = await engagementFactory();
  const reviewer = await userFactory();
  await companyMemberFactory({ companyId: engagement.companyId, userId: reviewer.id });
  return { engagement, reviewerUserId: reviewer.id };
}

function upsertInput(
  engagement: EngagementFactoryResult,
  reviewerUserId: string,
  overrides: Partial<UpsertReviewInput> = {}
): UpsertReviewInput {
  return {
    engagementId: engagement.engagement.id,
    reviewerUserId,
    expertProfileId: engagement.expertProfileId,
    rating: 5,
    body: null,
    surface: 'end_of_call',
    authMethod: 'session',
    ...overrides,
  };
}

async function auditRowsFor(entityId: string): Promise<AuditEvent[]> {
  return db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.entityType, 'review'), eq(auditEvents.entityId, entityId)));
}

/** The LIVE review ids on one engagement — the row-count assertion the upsert tests make. */
async function liveReviewIdsForEngagement(engagementId: string): Promise<string[]> {
  const rows = await db
    .select({ id: reviews.id })
    .from(reviews)
    .where(and(eq(reviews.engagementId, engagementId), isNull(reviews.deletedAt)));
  return rows.map((row) => row.id);
}

/**
 * The DENORMALISED columns as they are actually STORED — read raw, so `rating_average`
 * arrives as the `numeric` STRING postgres-js really returns ('4.3', not 4.3).
 *
 * ⚠ ASSERTED AS A STRING ON PURPOSE. Comparing against a number here would silently
 * pass through a `parseRatingAverage` that returned `4.30000000001`, and would hide the
 * single most important property of this column: the rounding to one decimal happened
 * ONCE, in Postgres, on assignment. `'4.3'` can only come from `numeric(2,1)`.
 */
async function storedAggregate(
  expertProfileId: string
): Promise<{ ratingAverage: string | null; ratingCount: number }> {
  const [row] = await db
    .select({
      ratingAverage: expertProfiles.ratingAverage,
      ratingCount: expertProfiles.ratingCount,
    })
    .from(expertProfiles)
    .where(eq(expertProfiles.id, expertProfileId));
  if (row === undefined) {
    throw new Error(`expert profile ${expertProfileId} not found`);
  }
  return row;
}

/**
 * Seed one engagement for `expertProfileId` and write `ratings` to it, one per reviewer,
 * THROUGH `reviewsRepository.upsert` — so every write exercises the real recompute hook.
 *
 * ⚠ Multiple ratings on ONE engagement is the shape the whole per-engagement decision
 * turns on: the partial unique permits one live review per PERSON per engagement, so
 * each rating needs its own company member.
 */
async function seedEngagementWithRatings(
  expertProfileId: string,
  ratings: number[]
): Promise<EngagementFactoryResult> {
  const engagement = await engagementFactory({ expertProfileId });
  for (const rating of ratings) {
    const reviewer = await userFactory();
    await companyMemberFactory({ companyId: engagement.companyId, userId: reviewer.id });
    await reviewsRepository.upsert(upsertInput(engagement, reviewer.id, { rating }));
  }
  return engagement;
}

describe('reviewsRepository.upsert — the targetWhere proof', () => {
  /**
   * ⚠⚠ THIS IS THE TEST THE WHOLE TABLE HANGS ON. The arbiter index is PARTIAL on
   * `deleted_at IS NULL`; if the repository's `onConflictDoUpdate` ever loses its
   * matching `targetWhere`, Postgres cannot infer the arbiter and raises 42P10 at PLAN
   * time — on the FIRST statement, not the second. Typecheck stays green. This suite is
   * the only thing that catches it.
   */
  it('updates IN PLACE on the same (engagement, reviewer, expert) triple — one row, same id', async () => {
    const { engagement, reviewerUserId } = await seedEngagementAndReviewer();

    const first = await reviewsRepository.upsert(
      upsertInput(engagement, reviewerUserId, { rating: 2, body: 'Rough start' })
    );
    expect(first.created).toBe(true);
    expect(first.review.lastEditedAt).toBeNull();

    const second = await reviewsRepository.upsert(
      upsertInput(engagement, reviewerUserId, {
        rating: 5,
        body: 'They turned it around',
        surface: 'email',
        authMethod: 'magic_link',
      })
    );

    expect(second.created).toBe(false);
    expect(second.review.id).toBe(first.review.id);
    expect(second.review.rating).toBe(5);
    expect(second.review.body).toBe('They turned it around');
    expect(second.review.surface).toBe('email');
    expect(second.review.authMethod).toBe('magic_link');
    expect(second.review.lastEditedAt).toBeInstanceOf(Date);

    const live = await liveReviewIdsForEngagement(engagement.engagement.id);
    expect(live).toHaveLength(1);
  });

  it('writes review.submitted on the insert branch and review.updated on the update branch, in the same tx', async () => {
    const { engagement, reviewerUserId } = await seedEngagementAndReviewer();

    const first = await reviewsRepository.upsert(
      upsertInput(engagement, reviewerUserId, { rating: 3 })
    );
    let audits = await auditRowsFor(first.review.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe('review.submitted');
    expect(audits[0]?.actorUserId).toBe(reviewerUserId);
    // The rating rides the audit metadata BECAUSE the upsert destroys the previous one —
    // the audit trail is the only history a changed rating has.
    expect(audits[0]?.metadata).toMatchObject({
      engagementId: engagement.engagement.id,
      expertProfileId: engagement.expertProfileId,
      rating: 3,
      surface: 'end_of_call',
      authMethod: 'session',
    });

    await reviewsRepository.upsert(upsertInput(engagement, reviewerUserId, { rating: 1 }));
    audits = await auditRowsFor(first.review.id);
    expect(audits).toHaveLength(2);
    expect(audits.map((row) => row.action).sort()).toEqual(['review.submitted', 'review.updated']);
    // The destroyed 3 survives in the ledger alongside the new 1.
    const ratings = audits.map((row) => (row.metadata as { rating?: number } | null)?.rating);
    expect(ratings.sort()).toEqual([1, 3]);
  });

  it('lets a SOFT-DELETED review free the slot — the partial predicate, distinct from targetWhere', async () => {
    const { engagement, reviewerUserId } = await seedEngagementAndReviewer();

    const first = await reviewsRepository.upsert(
      upsertInput(engagement, reviewerUserId, { rating: 1, body: 'Moderated away' })
    );

    await db.update(reviews).set({ deletedAt: new Date() }).where(eq(reviews.id, first.review.id));

    // No 23505: the partial unique only covers live rows, so a NEW row is inserted.
    const second = await reviewsRepository.upsert(
      upsertInput(engagement, reviewerUserId, { rating: 4 })
    );

    expect(second.created).toBe(true);
    expect(second.review.id).not.toBe(first.review.id);
    const live = await liveReviewIdsForEngagement(engagement.engagement.id);
    expect(live).toHaveLength(1);
  });

  it('keeps two different reviewers on one engagement as two separate rows', async () => {
    const engagement = await engagementFactory();
    const alex = await userFactory();
    const dana = await userFactory();
    await companyMemberFactory({ companyId: engagement.companyId, userId: alex.id });
    await companyMemberFactory({ companyId: engagement.companyId, userId: dana.id });

    const a = await reviewsRepository.upsert(upsertInput(engagement, alex.id, { rating: 5 }));
    const b = await reviewsRepository.upsert(upsertInput(engagement, dana.id, { rating: 2 }));

    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(a.review.id).not.toBe(b.review.id);
    const live = await liveReviewIdsForEngagement(engagement.engagement.id);
    expect(live).toHaveLength(2);
  });

  it('keeps one reviewer across two engagements as two separate rows', async () => {
    const reviewer = await userFactory();
    const first = await engagementFactory();
    const second = await engagementFactory();
    await companyMemberFactory({ companyId: first.companyId, userId: reviewer.id });
    await companyMemberFactory({ companyId: second.companyId, userId: reviewer.id });

    const a = await reviewsRepository.upsert(upsertInput(first, reviewer.id));
    const b = await reviewsRepository.upsert(upsertInput(second, reviewer.id));

    expect(a.review.id).not.toBe(b.review.id);
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
  });
});

describe('reviewsRepository.upsert — the DB constraints', () => {
  it.each([0, 6, -1, 100])(
    'rejects rating %i with 23514 on review_rating_range',
    async (rating) => {
      const { engagement, reviewerUserId } = await seedEngagementAndReviewer();
      await expect(
        reviewsRepository.upsert(upsertInput(engagement, reviewerUserId, { rating }))
      ).rejects.toMatchObject({ code: '23514' });
    }
  );

  it.each([1, 2, 3, 4, 5])('accepts rating %i', async (rating) => {
    const { engagement, reviewerUserId } = await seedEngagementAndReviewer();
    const result = await reviewsRepository.upsert(
      upsertInput(engagement, reviewerUserId, { rating })
    );
    expect(result.review.rating).toBe(rating);
  });

  it('rejects a whitespace-only body with 23514 — a blank body is a bug, not an opinion', async () => {
    const { engagement, reviewerUserId } = await seedEngagementAndReviewer();
    await expect(
      reviewsRepository.upsert(upsertInput(engagement, reviewerUserId, { body: '   ' }))
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('accepts a NULL body — a rating-only review is the common case', async () => {
    const { engagement, reviewerUserId } = await seedEngagementAndReviewer();
    const result = await reviewsRepository.upsert(
      upsertInput(engagement, reviewerUserId, { body: null })
    );
    expect(result.review.body).toBeNull();
  });

  it('stores the body as PLAIN TEXT, byte-for-byte — never sanitised, never escaped here', async () => {
    const { engagement, reviewerUserId } = await seedEngagementAndReviewer();
    const body = 'Sorted our <flow> & the "quote" issue in 1 call';
    const result = await reviewsRepository.upsert(
      upsertInput(engagement, reviewerUserId, { body })
    );
    expect(result.review.body).toBe(body);
  });

  it('REJECTS an expertProfileId that disagrees with the engagement (23503) — structural coherence', async () => {
    // ⚠ THE STRUCTURAL-COHERENCE PROOF. `review_engagement_expert_fk` composite-FKs
    // (engagement_id, expert_profile_id) against `engagement_id_expert_uq`, so a review
    // naming an expert who did not deliver the engagement is IMPOSSIBLE AT THE DATABASE.
    const { engagement, reviewerUserId } = await seedEngagementAndReviewer();
    const otherExpert = await expertDraftFactory();

    await expect(
      reviewsRepository.upsert(
        upsertInput(engagement, reviewerUserId, { expertProfileId: otherExpert.id })
      )
    ).rejects.toMatchObject({ code: '23503' });
  });
});

describe('reviewsRepository.findLive', () => {
  it('finds the reviewer’s live review', async () => {
    const { review, engagementId, reviewerUserId, expertProfileId } = await reviewFactory();
    const found = await reviewsRepository.findLive(engagementId, reviewerUserId, expertProfileId);
    expect(found?.id).toBe(review.id);
  });

  it('excludes a soft-deleted review', async () => {
    const { review, engagementId, reviewerUserId, expertProfileId } = await reviewFactory({
      values: { deletedAt: new Date() },
    });
    expect(review.deletedAt).toBeInstanceOf(Date);
    await expect(
      reviewsRepository.findLive(engagementId, reviewerUserId, expertProfileId)
    ).resolves.toBeUndefined();
  });

  it('returns undefined for a reviewer who has not rated', async () => {
    const { engagementId, expertProfileId } = await reviewFactory();
    const stranger = await userFactory();
    await expect(
      reviewsRepository.findLive(engagementId, stranger.id, expertProfileId)
    ).resolves.toBeUndefined();
  });
});

describe('reviewsRepository.filterUnratedReviewers', () => {
  it('returns the set difference — only the candidates with no live review', async () => {
    const engagement = await engagementFactory();
    const rated = await userFactory();
    const unratedOne = await userFactory();
    const unratedTwo = await userFactory();
    await companyMemberFactory({ companyId: engagement.companyId, userId: rated.id });

    await reviewsRepository.upsert(upsertInput(engagement, rated.id));

    const result = await reviewsRepository.filterUnratedReviewers({
      engagementId: engagement.engagement.id,
      expertProfileId: engagement.expertProfileId,
      candidateUserIds: [rated.id, unratedOne.id, unratedTwo.id],
    });

    expect(result.sort()).toEqual([unratedOne.id, unratedTwo.id].sort());
  });

  it('counts a SOFT-DELETED review as unrated — the slot is free again', async () => {
    const { engagementId, reviewerUserId, expertProfileId } = await reviewFactory({
      values: { deletedAt: new Date() },
    });

    await expect(
      reviewsRepository.filterUnratedReviewers({
        engagementId,
        expertProfileId,
        candidateUserIds: [reviewerUserId],
      })
    ).resolves.toEqual([reviewerUserId]);
  });

  it('short-circuits an empty candidate list without a round trip', async () => {
    await expect(
      reviewsRepository.filterUnratedReviewers({
        engagementId: '00000000-0000-0000-0000-000000000000',
        expertProfileId: '00000000-0000-0000-0000-000000000000',
        candidateUserIds: [],
      })
    ).resolves.toEqual([]);
  });

  it('does not let a review on a DIFFERENT engagement suppress this one', async () => {
    const reviewer = await userFactory();
    const rated = await engagementFactory();
    const unrated = await engagementFactory();
    await companyMemberFactory({ companyId: rated.companyId, userId: reviewer.id });
    await reviewsRepository.upsert(upsertInput(rated, reviewer.id));

    await expect(
      reviewsRepository.filterUnratedReviewers({
        engagementId: unrated.engagement.id,
        expertProfileId: unrated.expertProfileId,
        candidateUserIds: [reviewer.id],
      })
    ).resolves.toEqual([reviewer.id]);
  });
});

describe('reviewsRepository.aggregateForExpert', () => {
  it('averages and counts the live rows for one expert', async () => {
    const expert = await expertDraftFactory();
    for (const rating of [5, 4, 3]) {
      await seedEngagementWithRatings(expert.id, [rating]);
    }

    const aggregate = await reviewsRepository.aggregateForExpert(expert.id);
    expect(aggregate.ratedEngagementCount).toBe(3);
    expect(aggregate.averageRating).toBeCloseTo(4, 5);
  });

  it('COUNTS a review on an ACTIVE (non-terminal) engagement — there is no terminal-state gate', async () => {
    const expert = await expertDraftFactory();
    const engagement = await engagementFactory({
      expertProfileId: expert.id,
      projectValues: { deliveryStatus: 'active' },
    });
    expect(engagement.engagement.status).toBe('active');
    const reviewer = await userFactory();
    await companyMemberFactory({ companyId: engagement.companyId, userId: reviewer.id });
    await reviewsRepository.upsert(upsertInput(engagement, reviewer.id, { rating: 5 }));

    await expect(reviewsRepository.aggregateForExpert(expert.id)).resolves.toEqual({
      ratedEngagementCount: 1,
      averageRating: 5,
    });
  });

  it('excludes soft-deleted rows', async () => {
    const expert = await expertDraftFactory();
    const engagement = await engagementFactory({ expertProfileId: expert.id });
    const live = await reviewFactory({ engagement, values: { rating: 4 } });
    const other = await userFactory();
    await companyMemberFactory({ companyId: engagement.companyId, userId: other.id });
    await reviewFactory({
      engagement,
      reviewerUserId: other.id,
      values: { rating: 1, deletedAt: new Date() },
    });

    expect(live.review.rating).toBe(4);
    await expect(reviewsRepository.aggregateForExpert(expert.id)).resolves.toEqual({
      ratedEngagementCount: 1,
      averageRating: 4,
    });
  });

  it('returns a zero/null aggregate for an expert with no reviews — never throws', async () => {
    const expert = await expertDraftFactory();
    await expect(reviewsRepository.aggregateForExpert(expert.id)).resolves.toEqual({
      ratedEngagementCount: 0,
      averageRating: null,
    });
  });

  /**
   * ⚠ THE TEST THAT PROVES PER-ENGAGEMENT WAS ACTUALLY IMPLEMENTED, on the READ side.
   * Five reviewers on ONE engagement is ONE vote — see the stored-column suite below for
   * the same fixture asserted against `expert_profiles`.
   */
  it('counts FIVE reviewers on ONE engagement as ONE rated engagement, not five', async () => {
    const expert = await expertDraftFactory();
    await seedEngagementWithRatings(expert.id, [5, 5, 5, 1, 4]);

    const aggregate = await reviewsRepository.aggregateForExpert(expert.id);
    expect(aggregate.ratedEngagementCount).toBe(1);
    expect(aggregate.averageRating).toBeCloseTo(4, 5); // (5+5+5+1+4)/5 — within the one engagement
  });
});

describe('reviewsRepository.recomputeRatingAggregate — ONE ENGAGEMENT, ONE VOTE', () => {
  /**
   * ⚠⚠ THE FIXTURE THAT DISCRIMINATES THREE WAYS AT ONCE. Do NOT substitute a "simpler"
   * one: most naive fixtures cannot tell these apart, because symmetric rounding errors
   * cancel.
   *
   *   engagement A: 5, 5, 4  → 14/3 = 4.6666…
   *   engagement B: 4        → 4.0
   *
   *   ROUND ONCE, at the outer AVG (CORRECT):  (4.6666… + 4)/2 = 4.3333… → stored '4.3'
   *   ROUND EACH ENGAGEMENT FIRST (the bug):   (4.7      + 4)/2 = 4.35   → stored '4.4'
   *   FLAT AVG OVER ROWS (pre-decision):       avg([5,5,4,4])  = 4.5     → stored '4.5', count 4
   *
   * So ONE four-row fixture pins per-engagement WEIGHTING, SINGLE rounding, AND
   * `rating_count = 2`. All three are asserted below, by value, in one test.
   */
  it('stores 4.3 — NOT 4.4 (rounded per engagement) and NOT 4.5 (flat per row)', async () => {
    const expert = await expertDraftFactory();
    await seedEngagementWithRatings(expert.id, [5, 5, 4]);
    await seedEngagementWithRatings(expert.id, [4]);

    const stored = await storedAggregate(expert.id);

    expect(stored.ratingAverage).toBe('4.3');
    expect(stored.ratingAverage).not.toBe('4.4'); // spelled out: the round-each-first bug
    expect(stored.ratingAverage).not.toBe('4.5'); // spelled out: the flat per-row regression
    expect(stored.ratingCount).toBe(2); // ENGAGEMENTS reviewed, not the 4 review rows
  });

  it('counts FIVE reviewers on ONE engagement as rating_count = 1', async () => {
    // The single most important behavioural change in BAL-422, and the case a 5-member
    // company would otherwise use to outvote a 1-person company 5:1 on one piece of work.
    const expert = await expertDraftFactory();
    await seedEngagementWithRatings(expert.id, [5, 5, 5, 5, 5]);

    await expect(storedAggregate(expert.id)).resolves.toEqual({
      ratingAverage: '5.0',
      ratingCount: 1,
    });
  });

  it('counts a CASE and a PROJECT engagement alike — the aggregate never reads engagement_type', async () => {
    const expert = await expertDraftFactory();
    await seedEngagementWithRatings(expert.id, [5]);

    const caseSeed = await caseEngagementFactory({ expertProfileId: expert.id });
    const reviewer = await userFactory();
    await companyMemberFactory({ companyId: caseSeed.companyId, userId: reviewer.id });
    await reviewsRepository.upsert({
      engagementId: caseSeed.engagement.id,
      reviewerUserId: reviewer.id,
      expertProfileId: expert.id,
      rating: 3,
      body: null,
      surface: 'end_of_call',
      authMethod: 'session',
    });

    await expect(storedAggregate(expert.id)).resolves.toEqual({
      ratingAverage: '4.0',
      ratingCount: 2,
    });
  });

  it('EXCLUDES soft-deleted rows (the reworded AC — there is no moderation write path yet)', async () => {
    // ⚠ `reviewFactory` inserts DIRECTLY and does NOT recompute, so the recompute is
    // driven explicitly here. That is also the whole seam a future moderation ticket
    // needs: `update … set deletedAt` then `recomputeRatingAggregate(expertProfileId, tx)`.
    const expert = await expertDraftFactory();
    const engagement = await seedEngagementWithRatings(expert.id, [5]);

    const other = await userFactory();
    await companyMemberFactory({ companyId: engagement.companyId, userId: other.id });
    const moderated = await reviewFactory({
      engagement,
      reviewerUserId: other.id,
      values: { rating: 1, deletedAt: new Date() },
    });
    expect(moderated.review.deletedAt).toBeInstanceOf(Date);

    await expect(reviewsRepository.recomputeRatingAggregate(expert.id)).resolves.toEqual({
      ratingAverage: 5,
      ratingCount: 1,
    });
    // The 1 never reached the stored column: a 5 and a moderated 1 would average 3.0.
    await expect(storedAggregate(expert.id)).resolves.toEqual({
      ratingAverage: '5.0',
      ratingCount: 1,
    });
  });

  it('drops an engagement out of the count when its ONLY review is soft-deleted', async () => {
    const expert = await expertDraftFactory();
    await seedEngagementWithRatings(expert.id, [5]);
    const doomed = await seedEngagementWithRatings(expert.id, [1]);
    await expect(storedAggregate(expert.id)).resolves.toEqual({
      ratingAverage: '3.0',
      ratingCount: 2,
    });

    await db
      .update(reviews)
      .set({ deletedAt: new Date() })
      .where(eq(reviews.engagementId, doomed.engagement.id));
    await reviewsRepository.recomputeRatingAggregate(expert.id);

    await expect(storedAggregate(expert.id)).resolves.toEqual({
      ratingAverage: '5.0',
      ratingCount: 1,
    });
  });

  it('leaves NULL / 0 for an expert with no reviews — never 0.0', async () => {
    // ⚠ Falls out of aggregate-over-the-empty-set, with NO special case in the code: an
    // aggregate over zero rows still returns one row, so `avg` is NULL and `count(*)` is 0.
    const expert = await expertDraftFactory();

    await expect(reviewsRepository.recomputeRatingAggregate(expert.id)).resolves.toEqual({
      ratingAverage: null,
      ratingCount: 0,
    });
    const stored = await storedAggregate(expert.id);
    expect(stored.ratingAverage).toBeNull();
    expect(stored.ratingAverage).not.toBe('0.0');
    expect(stored.ratingCount).toBe(0);
  });

  it('is IDEMPOTENT — a second recompute over the same rows stores the same value', async () => {
    const expert = await expertDraftFactory();
    await seedEngagementWithRatings(expert.id, [5, 5, 4]);
    await seedEngagementWithRatings(expert.id, [4]);

    const first = await reviewsRepository.recomputeRatingAggregate(expert.id);
    const second = await reviewsRepository.recomputeRatingAggregate(expert.id);
    expect(second).toEqual(first);
    expect(second.ratingAverage).toBe(4.3);
  });

  it('THROWS for an unknown expert profile — the locking read found no row', async () => {
    // An integrity violation (a review naming a non-existent expert), not a normal miss.
    // `@balo/db` throws; the caller's existing catch logs it.
    await expect(
      reviewsRepository.recomputeRatingAggregate('00000000-0000-0000-0000-000000000000')
    ).rejects.toThrow(/not found/);
  });

  it('does not let ANOTHER expert’s reviews bleed into this expert’s aggregate', async () => {
    const mine = await expertDraftFactory();
    const theirs = await expertDraftFactory();
    await seedEngagementWithRatings(mine.id, [5]);
    await seedEngagementWithRatings(theirs.id, [1, 1, 1]);

    await expect(storedAggregate(mine.id)).resolves.toEqual({
      ratingAverage: '5.0',
      ratingCount: 1,
    });
    await expect(storedAggregate(theirs.id)).resolves.toEqual({
      ratingAverage: '1.0',
      ratingCount: 1,
    });
  });
});

describe('reviewsRepository.upsert — the recompute is UNBYPASSABLE', () => {
  /**
   * ⚠ THIS TEST PINS THE CALL, and it is the thing that stops the hook drifting out of
   * the transaction. A BARE `upsert` — no second call, no explicit recompute — must
   * leave both denormalised columns correct. If a future refactor moves the review write
   * out of `db.transaction` or makes the recompute conditional, this goes red.
   */
  it('writes BOTH columns from a bare upsert, with no second call', async () => {
    const expert = await expertDraftFactory();
    const engagement = await engagementFactory({ expertProfileId: expert.id });
    const reviewer = await userFactory();
    await companyMemberFactory({ companyId: engagement.companyId, userId: reviewer.id });

    await expect(storedAggregate(expert.id)).resolves.toEqual({
      ratingAverage: null,
      ratingCount: 0,
    });

    await reviewsRepository.upsert(upsertInput(engagement, reviewer.id, { rating: 4 }));

    await expect(storedAggregate(expert.id)).resolves.toEqual({
      ratingAverage: '4.0',
      ratingCount: 1,
    });
  });

  /**
   * ⚠ `upsert` RETURNS THE COMMITTED `ratingCount`, and it must be the STORED value, not a
   * guess (BAL-422 fix round). `applyReview` logs it as drift telemetry — an operator
   * comparing the aggregate against the review rows reads THIS number — so a return value
   * that disagreed with the column would be worse than no telemetry at all. Pinned against
   * `storedAggregate`, which reads the column back, rather than against a literal.
   */
  it('returns the ratingCount it actually committed', async () => {
    const expert = await expertDraftFactory();
    const reviewer = await userFactory();
    const first = await engagementFactory({ expertProfileId: expert.id });
    await companyMemberFactory({ companyId: first.companyId, userId: reviewer.id });

    const inserted = await reviewsRepository.upsert(upsertInput(first, reviewer.id, { rating: 4 }));
    expect(inserted.ratingCount).toBe((await storedAggregate(expert.id)).ratingCount);
    expect(inserted.ratingCount).toBe(1);

    // A SECOND engagement is a second vote…
    const second = await engagementFactory({ expertProfileId: expert.id });
    await companyMemberFactory({ companyId: second.companyId, userId: reviewer.id });
    const added = await reviewsRepository.upsert(upsertInput(second, reviewer.id, { rating: 2 }));
    expect(added.ratingCount).toBe(2);

    // …but a REVISION of one is not, and the returned count must follow the same rule the
    // column does rather than incrementing on every write.
    const revised = await reviewsRepository.upsert(upsertInput(second, reviewer.id, { rating: 5 }));
    expect(revised.created).toBe(false);
    expect(revised.ratingCount).toBe(2);
    expect(revised.ratingCount).toBe((await storedAggregate(expert.id)).ratingCount);
  });

  it('RECOMPUTES on the UPDATE branch — a revised rating cannot leave the old value behind', async () => {
    // The case an insert-only or delta hook silently drifts on: the upsert DESTROYS the
    // previous rating, so anything short of a from-scratch recompute keeps a dead number.
    const expert = await expertDraftFactory();
    const engagement = await engagementFactory({ expertProfileId: expert.id });
    const reviewer = await userFactory();
    await companyMemberFactory({ companyId: engagement.companyId, userId: reviewer.id });

    await reviewsRepository.upsert(upsertInput(engagement, reviewer.id, { rating: 2 }));
    await expect(storedAggregate(expert.id)).resolves.toEqual({
      ratingAverage: '2.0',
      ratingCount: 1,
    });

    const revised = await reviewsRepository.upsert(
      upsertInput(engagement, reviewer.id, { rating: 5 })
    );
    expect(revised.created).toBe(false);

    await expect(storedAggregate(expert.id)).resolves.toEqual({
      ratingAverage: '5.0',
      ratingCount: 1, // still ONE engagement — a revision is not a second vote
    });
  });

  it('leaves the aggregate UNTOUCHED when the review write is rejected', async () => {
    // The recompute rides the SAME transaction as the review, so a rejected write (here
    // the `review_rating_range` CHECK) can never leave a half-applied aggregate behind.
    // ⚠ Read literally: this proves the FAILING path writes nothing. It does not, and
    // cannot, prove a recompute that ran and was then rolled back — nothing follows the
    // recompute inside the transaction, so there is no such ordering to construct.
    const expert = await expertDraftFactory();
    const engagement = await engagementFactory({ expertProfileId: expert.id });
    const reviewer = await userFactory();
    await companyMemberFactory({ companyId: engagement.companyId, userId: reviewer.id });
    await reviewsRepository.upsert(upsertInput(engagement, reviewer.id, { rating: 3 }));

    const second = await engagementFactory({ expertProfileId: expert.id });
    const otherReviewer = await userFactory();
    await companyMemberFactory({ companyId: second.companyId, userId: otherReviewer.id });
    await expect(
      reviewsRepository.upsert(upsertInput(second, otherReviewer.id, { rating: 9 }))
    ).rejects.toMatchObject({ code: '23514' });

    await expect(storedAggregate(expert.id)).resolves.toEqual({
      ratingAverage: '3.0',
      ratingCount: 1,
    });
  });
});

describe('the READ and the WRITE cannot drift apart', () => {
  /**
   * ⚠ THE STANDING JOB OF `aggregateForExpert`. Both wrap the SAME
   * `perEngagementAverages` fragment, so this is what catches someone "optimising" one
   * of them into a different definition of the aggregate. Rounding the read to 1dp must
   * reproduce the stored column EXACTLY, on every fixture.
   */
  it.each<[string, number[][]]>([
    ['the 4.3 discriminator', [[5, 5, 4], [4]]],
    ['five reviewers on one engagement', [[5, 5, 5, 1, 4]]],
    ['a lopsided pair', [[1], [5, 5, 5, 5]]],
    ['a single review', [[3]]],
    ['a .x5 tie that rounds AWAY from zero', [[4], [5], [4], [4]]],
  ])('%s', async (_label, engagementRatings) => {
    const expert = await expertDraftFactory();
    for (const ratings of engagementRatings) {
      await seedEngagementWithRatings(expert.id, ratings);
    }

    const read = await reviewsRepository.aggregateForExpert(expert.id);
    const stored = await storedAggregate(expert.id);

    expect(read.ratedEngagementCount).toBe(stored.ratingCount);
    if (read.averageRating === null) {
      throw new Error('fixture must produce a rating');
    }
    expect(read.averageRating.toFixed(1)).toBe(stored.ratingAverage);
  });
});

describe('reviewsRepository.findLandingContext — THE LEAK REGRESSION TEST', () => {
  // ⚠ NO IDS. The landing form's only identity field is the token, so `engagementId` and
  // `expertProfileId` would ride into an unauthenticated RSC payload with no reader.
  const EXPECTED_KEYS = [
    'clientCompanyName',
    'concludedOnIso',
    'engagementKind',
    'expertGivenName',
    'expertPartyLabel',
    'reviewerFirstName',
    'title',
  ];

  it('returns EXACTLY the declared key set for a project — and nothing else', async () => {
    const { engagement, reviewerUserId } = await seedEngagementAndReviewer();

    const context = await reviewsRepository.findLandingContext(
      engagement.engagement.id,
      reviewerUserId
    );
    if (context === undefined) {
      throw new Error('expected a landing context');
    }

    // EXACT SET EQUALITY. Adding a field to the query without adding it to
    // `ReviewLandingContext` fails here, which is the point: this projection is handed to
    // an UNAUTHENTICATED page.
    expect(Object.keys(context).sort()).toEqual(EXPECTED_KEYS);

    // The named leaks, spelled out so a reviewer can see them checked.
    const serialised = JSON.stringify(context);
    expect(context).not.toHaveProperty('baloFeeBps');
    expect(context).not.toHaveProperty('email');
    expect(context).not.toHaveProperty('workosId');
    expect(context).not.toHaveProperty('stripeConnectId');
    expect(serialised).not.toContain('2500');
    expect(serialised).not.toContain('@');

    // …and NO IDS AT ALL. Named separately from the key set because these two were once
    // projected and read by nobody; asserting the values are gone (not just the keys)
    // catches a re-add under a different name.
    expect(context).not.toHaveProperty('engagementId');
    expect(context).not.toHaveProperty('expertProfileId');
    expect(serialised).not.toContain(engagement.engagement.id);
    expect(serialised).not.toContain(engagement.expertProfileId);
  });

  it('resolves a CASE engagement, taking the title and the closed_at anchor from the child', async () => {
    const closedAt = new Date('2026-08-01T10:00:00.000Z');
    const seeded = await caseEngagementFactory({
      caseValues: {
        title: 'Broken approval flow',
        closedAt,
        closeReason: 'auto_inactive',
      },
      values: { status: 'completed' },
    });
    const reviewer = await userFactory();
    await companyMemberFactory({ companyId: seeded.companyId, userId: reviewer.id });

    const context = await reviewsRepository.findLandingContext(seeded.engagement.id, reviewer.id);

    expect(context?.engagementKind).toBe('case');
    expect(context?.title).toBe('Broken approval flow');
    expect(context?.concludedOnIso).toBe(closedAt.toISOString());
    expect(Object.keys(context ?? {}).sort()).toEqual(EXPECTED_KEYS);
  });

  it('carries the reviewer’s FIRST NAME only — never their email', async () => {
    const engagement = await engagementFactory();
    const reviewer = await userFactory({
      firstName: 'Dana',
      lastName: 'Okafor',
      email: `dana-${Date.now()}@northwind.example`,
    });
    await companyMemberFactory({ companyId: engagement.companyId, userId: reviewer.id });

    const context = await reviewsRepository.findLandingContext(
      engagement.engagement.id,
      reviewer.id
    );

    expect(context?.reviewerFirstName).toBe('Dana');
    expect(JSON.stringify(context)).not.toContain('Okafor');
    expect(JSON.stringify(context)).not.toContain('northwind.example');
  });

  it('falls back to a neutral title when a project has no origination row (the retainer seam)', async () => {
    const { engagement, reviewerUserId } = await seedEngagementAndReviewer();
    const context = await reviewsRepository.findLandingContext(
      engagement.engagement.id,
      reviewerUserId
    );
    expect(context?.title).toBe('your project');
  });

  it('takes the title from the source project request when there is one', async () => {
    const engagement = await engagementFactory({ withSourceProposal: true });
    const reviewer = await userFactory();
    await companyMemberFactory({ companyId: engagement.companyId, userId: reviewer.id });

    const context = await reviewsRepository.findLandingContext(
      engagement.engagement.id,
      reviewer.id
    );
    expect(context?.title).not.toBe('your project');
    expect((context?.title ?? '').length).toBeGreaterThan(0);
  });

  it('returns undefined for a soft-deleted engagement', async () => {
    const { engagement, reviewerUserId } = await seedEngagementAndReviewer();
    const deleted = await engagementFactory({ values: { deletedAt: new Date() } });

    await expect(
      reviewsRepository.findLandingContext(deleted.engagement.id, reviewerUserId)
    ).resolves.toBeUndefined();
    // control: the live one still resolves
    await expect(
      reviewsRepository.findLandingContext(engagement.engagement.id, reviewerUserId)
    ).resolves.toBeDefined();
  });

  it('returns undefined for an unknown engagement and for an unknown reviewer', async () => {
    const { engagement, reviewerUserId } = await seedEngagementAndReviewer();

    await expect(
      reviewsRepository.findLandingContext('00000000-0000-0000-0000-000000000000', reviewerUserId)
    ).resolves.toBeUndefined();
    await expect(
      reviewsRepository.findLandingContext(
        engagement.engagement.id,
        '00000000-0000-0000-0000-000000000000'
      )
    ).resolves.toBeUndefined();
  });
});

describe('reviewsRepository.listPublicByExpert — D6', () => {
  const EXPECTED_KEYS = ['body', 'clientCompanyName', 'createdAtIso', 'id', 'rating'];

  it('attributes to the client COMPANY and NEVER exposes the reviewer', async () => {
    const expert = await expertDraftFactory();
    const engagement = await engagementFactory({ expertProfileId: expert.id });
    const { reviewerUserId } = await reviewFactory({
      engagement,
      values: { rating: 5, body: 'Unblocked us in one call' },
    });

    const published = await reviewsRepository.listPublicByExpert(expert.id);
    expect(published).toHaveLength(1);

    const [row] = published;
    if (row === undefined) {
      throw new Error('expected one published review');
    }
    // EXACT SET EQUALITY — the allow-list is the mechanism, this is the guard.
    expect(Object.keys(row).sort()).toEqual(EXPECTED_KEYS);
    expect(row).not.toHaveProperty('reviewerUserId');
    expect(JSON.stringify(published)).not.toContain(reviewerUserId);
    expect(row.rating).toBe(5);
    expect(row.body).toBe('Unblocked us in one call');
    expect(row.clientCompanyName.length).toBeGreaterThan(0);
  });

  it('excludes soft-deleted reviews', async () => {
    const expert = await expertDraftFactory();
    const engagement = await engagementFactory({ expertProfileId: expert.id });
    await reviewFactory({ engagement, values: { deletedAt: new Date() } });

    await expect(reviewsRepository.listPublicByExpert(expert.id)).resolves.toEqual([]);
  });

  it('returns [] for an expert with no reviews', async () => {
    const expert = await expertDraftFactory();
    await expect(reviewsRepository.listPublicByExpert(expert.id)).resolves.toEqual([]);
  });
});
