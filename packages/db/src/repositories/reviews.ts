import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { expertPartyDisplayName } from '@balo/shared/parties';
import type {
  PublicReview,
  ReviewAuthMethod,
  ReviewLandingContext,
  ReviewSurface,
} from '@balo/shared/reviews';
import { db } from '../client';
import {
  agencies,
  caseEngagements,
  companies,
  engagements,
  expertProfiles,
  projectEngagements,
  projectRequests,
  reviews,
  users,
  type Review,
} from '../schema';
import { auditEventsRepository } from './audit-events';

const ENTITY_TYPE = 'review';

export interface UpsertReviewInput {
  engagementId: string;
  reviewerUserId: string;
  /** ALWAYS derived from the engagement by the caller — NEVER accepted from client input. */
  expertProfileId: string;
  /** Caller Zod-validates 1..5; the DB CHECK `review_rating_range` is the enforcement. */
  rating: number;
  /** PLAIN TEXT, caller-trimmed. `@balo/db` never normalises and never sanitises. */
  body: string | null;
  surface: ReviewSurface;
  authMethod: ReviewAuthMethod;
}

export interface UpsertReviewResult {
  review: Review;
  /** `true` on the INSERT branch, `false` on the UPDATE branch. Drives the analytics split. */
  created: boolean;
}

/**
 * One nudge-eligible engagement, from either terminal anchor. Declared here (not on the
 * two anchor repositories) so `listAcceptedBetween` and `listClosedBetween` cannot drift
 * into two shapes the sweep would have to branch on.
 */
export interface RatingNudgeCandidate {
  engagementId: string;
  engagementKind: 'project' | 'case';
  companyId: string;
  expertProfileId: string;
  /** `accepted_at` (project) | `closed_at` (case). */
  anchorAt: Date;
  title: string;
  /**
   * CASE ONLY — `case_engagements.close_reason`, so the +7d nudge can say what actually
   * happened instead of asserting inactivity over a deliberate close. ALWAYS `undefined`
   * on the project arm (a project has no close reason), and left OPTIONAL rather than
   * `| null` so `listAcceptedBetween` stays free of a field it can never populate.
   * Nothing downstream may branch on its ABSENCE meaning anything but "not a case /
   * reason not recorded" — the nudge template falls back to reason-blind wording.
   */
  closeReason?: 'resolved' | 'auto_inactive';
}

/**
 * DRAFT COPY — pending MJ sign-off. The neutral stand-in when a project engagement has
 * no origination row to take a title from (the retainer seam: `project_request_id` is
 * NULLABLE and `ON DELETE SET NULL`, so a title is genuinely absent, not missing).
 */
export const UNTITLED_ENGAGEMENT_LABEL = 'your project';

/**
 * `reviewsRepository` (BAL-390) — one client-side rating per (engagement, reviewer,
 * expert), plus the reads the nudge sweep, the magic-link landing and the (unmounted,
 * BAL-422) public surface need.
 *
 * ⚠ NO AUTHORIZATION LIVES HERE. No capability is resolved, no role string is read
 * (ADR-1029: capabilities resolve at the CALL SITE, and both write paths are Next
 * Server Actions in `apps/web`). `filterUnratedReviewers` in particular is a
 * SURFACING read — "who has not rated yet" — and surfacing is not authorization.
 */
export const reviewsRepository = {
  /**
   * Write or replace THIS reviewer's review of THIS expert on THIS engagement.
   *
   * ⚠⚠ `targetWhere` IS MANDATORY, NOT DECORATION. The arbiter index
   * (`review_engagement_reviewer_expert_live_idx`) is PARTIAL on `deleted_at IS NULL`.
   * Postgres only selects a partial index as the ON CONFLICT arbiter when the statement
   * RESTATES its predicate; omit it and arbiter inference fails AT PLAN TIME, so EVERY
   * upsert — including the very first, on an empty table — raises 42P10 ("there is no
   * unique or exclusion constraint matching the ON CONFLICT specification"). Typecheck
   * stays green. Drizzle 0.38 spells it `targetWhere`; the bare `where` key is
   * @deprecated on this builder. House precedent: `repositories/conversations.ts`.
   *
   * NO `FOR UPDATE`, NO read-then-write. The partial unique index IS the concurrency
   * control: two simultaneous submits serialise on it, one inserts and the other takes
   * the DO UPDATE arm. Deliberately weaker than the `credit_sessions` lock pattern — a
   * review carries no money and last-write-wins is the correct semantics here.
   *
   * ONE transaction, because the audit row must commit with the review. The RATING goes
   * into the audit metadata precisely because the upsert DESTROYS the previous rating —
   * the audit row is then the only history a change has. `audit_events.action` is open
   * TEXT (ADR-1040 Lane 0's open-TEXT audit fold), so no enum migration.
   */
  upsert: async (input: UpsertReviewInput): Promise<UpsertReviewResult> => {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .insert(reviews)
        .values({
          engagementId: input.engagementId,
          reviewerUserId: input.reviewerUserId,
          expertProfileId: input.expertProfileId,
          rating: input.rating,
          body: input.body,
          surface: input.surface,
          authMethod: input.authMethod,
        })
        .onConflictDoUpdate({
          target: [reviews.engagementId, reviews.reviewerUserId, reviews.expertProfileId],
          // ⚠⚠ See the warning above. Removing this line breaks EVERY upsert with 42P10.
          targetWhere: isNull(reviews.deletedAt),
          set: {
            rating: input.rating,
            body: input.body,
            surface: input.surface,
            authMethod: input.authMethod,
            lastEditedAt: sql`now()`,
            updatedAt: sql`now()`,
          },
        })
        .returning();
      if (row === undefined) {
        throw new Error('reviews upsert returned no row');
      }

      // DETERMINISTIC created/updated discriminator: `last_edited_at` is NULL only on the
      // insert branch and is stamped by every update branch. A pre-read would race under
      // READ COMMITTED; this cannot.
      const created = row.lastEditedAt === null;

      await auditEventsRepository.record(
        {
          actorUserId: input.reviewerUserId,
          action: created ? 'review.submitted' : 'review.updated',
          entityType: ENTITY_TYPE,
          entityId: row.id,
          metadata: {
            engagementId: input.engagementId,
            expertProfileId: input.expertProfileId,
            rating: input.rating,
            surface: input.surface,
            authMethod: input.authMethod,
          },
        },
        tx
      );

      return { review: row, created };
    });
  },

  /** This reviewer's LIVE review of this expert on this engagement, if any. */
  findLive: async (
    engagementId: string,
    reviewerUserId: string,
    expertProfileId: string
  ): Promise<Review | undefined> => {
    const [row] = await db
      .select()
      .from(reviews)
      .where(
        and(
          eq(reviews.engagementId, engagementId),
          eq(reviews.reviewerUserId, reviewerUserId),
          eq(reviews.expertProfileId, expertProfileId),
          isNull(reviews.deletedAt)
        )
      );
    return row;
  },

  /**
   * Of `candidateUserIds`, which have NOT yet left a live review of this expert on this
   * engagement — a pure SQL set difference, in ONE round trip. An empty input returns
   * `[]` without touching the database.
   *
   * Reads NO role string: this decides who gets EMAILED, and surfacing is not
   * authorization (D10). The capability gate runs at submit time, per submit.
   */
  filterUnratedReviewers: async (input: {
    engagementId: string;
    expertProfileId: string;
    candidateUserIds: string[];
  }): Promise<string[]> => {
    if (input.candidateUserIds.length === 0) {
      return [];
    }

    const rated = await db
      .select({ reviewerUserId: reviews.reviewerUserId })
      .from(reviews)
      .where(
        and(
          eq(reviews.engagementId, input.engagementId),
          eq(reviews.expertProfileId, input.expertProfileId),
          inArray(reviews.reviewerUserId, input.candidateUserIds),
          isNull(reviews.deletedAt)
        )
      );

    const ratedIds = new Set(rated.map((row) => row.reviewerUserId));
    return input.candidateUserIds.filter((userId) => !ratedIds.has(userId));
  },

  /**
   * The expert's rating aggregate over LIVE rows. `deleted_at IS NULL` is the ONLY
   * filter — NO status filter, NO terminal-state gate, NO frozen window: a review counts
   * immediately. Rides `review_expert_live_idx` (`rating` is in the index, so the
   * aggregate is index-only).
   *
   * `expert_profiles` carries NO denormalised rating columns (verified), so there is
   * nothing to keep in sync — this function is the single source. BAL-422 mounts it.
   *
   * ⚠ FLAGGED, NOT CHOSEN (residual): this is an UNWEIGHTED flat AVG over rows. The
   * partial unique permits one review per PERSON per engagement, so a 5-member company
   * can contribute 5 ratings to one engagement where a 1-member company contributes 1.
   * Whether that is the intended weighting is undecided — do not silently pick one.
   */
  aggregateForExpert: async (
    expertProfileId: string
  ): Promise<{ count: number; averageRating: number | null }> => {
    const [row] = await db
      .select({
        count: sql<number>`cast(count(*) as int)`,
        averageRating: sql<number | null>`avg(${reviews.rating})::float8`,
      })
      .from(reviews)
      .where(and(eq(reviews.expertProfileId, expertProfileId), isNull(reviews.deletedAt)));

    return { count: row?.count ?? 0, averageRating: row?.averageRating ?? null };
  },

  /**
   * The UNAUTHENTICATED landing page's ENTIRE data surface — and the highest-risk
   * projection in this ticket.
   *
   * ⚠⚠ EXPLICIT `db.select({ … })` ONLY. Do NOT rewrite this as
   * `db.query.engagements.findFirst({ with: { expertProfile: true, company: true } })`:
   * Drizzle's relational `with:` hydrates FULL rows and is a documented secret-leak
   * footgun (`reference_drizzle_with_hydration_leaks_secrets`). Note also that
   * `engagementsRepository.findById` returns the full supertype row INCLUDING
   * `balo_fee_bps` (2500 on a project) — never spread that into a client component.
   * `ReviewLandingContext` is declared in `@balo/shared/reviews` so the page physically
   * cannot widen this shape; its key set is asserted in the integration suite.
   *
   * ⚠ IT SELECTS NO IDS. `engagements.id` and `engagements.expert_profile_id` are used in
   * the WHERE/JOINs and deliberately NOT projected: the landing form's only identity
   * field is the token, so an id here would reach an unauthenticated browser's RSC
   * payload with no reader. Every projected column is rendered.
   *
   * Takes the reviewer id as well as the engagement id because `reviewerFirstName` (the
   * forwarded-token disclosure) is a property of the TOKEN'S SUBJECT, not of the
   * engagement. The caller has just resolved the token, so it holds both.
   *
   * Returns `undefined` for a soft-deleted engagement, an unknown reviewer, or an
   * engagement type with no child row (`package` / `retainer` are declared-but-unbuilt).
   */
  findLandingContext: async (
    engagementId: string,
    reviewerUserId: string
  ): Promise<ReviewLandingContext | undefined> => {
    const [row] = await db
      .select({
        engagementType: engagements.engagementType,
        clientCompanyName: companies.name,
        expertType: expertProfiles.type,
        expertFirstName: users.firstName,
        expertLastName: users.lastName,
        agencyName: agencies.name,
        projectTitle: projectRequests.title,
        acceptedAt: projectEngagements.acceptedAt,
        caseTitle: caseEngagements.title,
        closedAt: caseEngagements.closedAt,
      })
      .from(engagements)
      .innerJoin(companies, eq(companies.id, engagements.companyId))
      .innerJoin(expertProfiles, eq(expertProfiles.id, engagements.expertProfileId))
      .innerJoin(users, eq(users.id, expertProfiles.userId))
      .leftJoin(agencies, eq(agencies.id, expertProfiles.agencyId))
      .leftJoin(
        projectEngagements,
        and(
          eq(projectEngagements.engagementId, engagements.id),
          isNull(projectEngagements.deletedAt)
        )
      )
      .leftJoin(projectRequests, eq(projectRequests.id, projectEngagements.projectRequestId))
      .leftJoin(
        caseEngagements,
        and(eq(caseEngagements.engagementId, engagements.id), isNull(caseEngagements.deletedAt))
      )
      .where(and(eq(engagements.id, engagementId), isNull(engagements.deletedAt)))
      .limit(1);

    if (row === undefined) {
      return undefined;
    }

    const engagementKind =
      row.engagementType === 'project' || row.engagementType === 'case'
        ? row.engagementType
        : undefined;
    if (engagementKind === undefined) {
      return undefined;
    }

    // A separate, minimal read: FIRST NAME ONLY, never the email address (§ the
    // forwarded-token disclosure — the form tells the reader whose name a submission
    // would carry, and that disclosure must not itself leak an inbox).
    const [reviewer] = await db
      .select({ firstName: users.firstName })
      .from(users)
      .where(and(eq(users.id, reviewerUserId), isNull(users.deletedAt)))
      .limit(1);
    if (reviewer === undefined) {
      return undefined;
    }

    const concludedOn = engagementKind === 'project' ? row.acceptedAt : row.closedAt;
    const title =
      engagementKind === 'project'
        ? (row.projectTitle ?? UNTITLED_ENGAGEMENT_LABEL)
        : (row.caseTitle ?? UNTITLED_ENGAGEMENT_LABEL);

    return {
      engagementKind,
      clientCompanyName: row.clientCompanyName,
      expertPartyLabel: expertPartyDisplayName({
        type: row.expertType,
        agencyName: row.agencyName,
        firstName: row.expertFirstName,
        lastName: row.expertLastName,
      }),
      expertGivenName: row.expertFirstName ?? 'your expert',
      reviewerFirstName: reviewer.firstName ?? 'there',
      title,
      concludedOnIso: concludedOn === null ? null : concludedOn.toISOString(),
    };
  },

  /**
   * D6 — the PUBLIC reviews of one expert, attributed to the CLIENT COMPANY.
   *
   * ⚠⚠ `reviews.reviewer_user_id` MUST NEVER APPEAR IN THIS PROJECTION. A published
   * review is a PARTY statement, not a personal one; the column stays in the table for
   * attribution and audit, and the rendering collapses to the company. The allow-list
   * below is the mechanism and an integration key-set assertion is the guard.
   *
   * Ships and is tested; NOTHING MOUNTS IT in this PR — BAL-422 owns the display surface.
   */
  listPublicByExpert: async (expertProfileId: string): Promise<PublicReview[]> => {
    const rows = await db
      .select({
        id: reviews.id,
        rating: reviews.rating,
        body: reviews.body,
        clientCompanyName: companies.name,
        createdAt: reviews.createdAt,
      })
      .from(reviews)
      .innerJoin(engagements, eq(engagements.id, reviews.engagementId))
      .innerJoin(companies, eq(companies.id, engagements.companyId))
      .where(and(eq(reviews.expertProfileId, expertProfileId), isNull(reviews.deletedAt)))
      .orderBy(desc(reviews.createdAt));

    return rows.map((row) => ({
      id: row.id,
      rating: row.rating,
      body: row.body,
      clientCompanyName: row.clientCompanyName,
      createdAtIso: row.createdAt.toISOString(),
    }));
  },
};
