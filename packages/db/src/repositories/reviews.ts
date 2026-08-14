import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import { expertPartyDisplayName } from '@balo/shared/parties';
import {
  parseRatingAverage,
  type PublicReview,
  type ReviewAuthMethod,
  type ReviewLandingContext,
  type ReviewSurface,
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
import type { DbExecutor } from './_shared/db-executor';

const ENTITY_TYPE = 'review';

/**
 * A standalone Drizzle builder — no executor, so a fragment built from it can never be
 * accidentally `await`ed into a query of its own. It exists only to compose SQL.
 */
const queryBuilder = new QueryBuilder();

/**
 * ⚠⚠ THE ONE DEFINITION OF "ONE ENGAGEMENT, ONE VOTE" (BAL-422, Yomi 2026-08-14).
 *
 *     select avg(rating) as engagement_average
 *     from reviews
 *     where expert_profile_id = $1 and deleted_at is null
 *     group by engagement_id
 *
 * One row per ENGAGEMENT that carries at least one live review, holding that
 * engagement's own average. Both the READ (`aggregateForExpert`) and the WRITE
 * (`recomputeRatingAggregate`) wrap THIS fragment, so the two cannot drift into
 * different definitions of the aggregate — which is the failure this ticket's
 * anti-drift test exists to catch.
 *
 * ⚠ THE WEIGHTING IS THE WHOLE POINT. The partial unique on `reviews` permits one live
 * review per (engagement, reviewer, expert), so a 5-member company can contribute FIVE
 * rows to ONE engagement where a 1-person company contributes one. A flat `avg(rating)`
 * over rows would let the larger company outvote the smaller one 5:1 on a single piece
 * of work. Grouping first makes every engagement count once. A rating is a statement by
 * the PARTY, which is the same ruling BAL-390 made for review BODIES.
 *
 * ⚠ NO ROUNDING HAPPENS HERE. `avg()` over `integer` returns exact `numeric`, and the
 * outer average over those numerics is exact too — the value never touches `float8` on
 * the write path. The single rounding is the assignment cast into `numeric(2,1)`. Round
 * each engagement first and `[5,5,4]` + `[4]` stores 4.4 instead of 4.3.
 *
 * ⚠ `reviews.deleted_at IS NULL` IS THE ONLY FILTER. No status filter, no terminal-state
 * gate, no frozen window: a review counts immediately. It also restates
 * `review_expert_live_idx`'s partial predicate, so the scan is index-only.
 *
 * ⚠ TWO KNOWN, DELIBERATE OMISSIONS FROM THAT FILTER — both latent, neither reachable
 * today, and both documented rather than guessed at:
 *   1. NO MODERATION PATH EXISTS. Nothing in this repository or anywhere else in the
 *      codebase ever sets `reviews.deleted_at` (verified), so the soft-delete arm of this
 *      predicate has no production writer. {@link recomputeRatingAggregate} is the seam a
 *      future moderation ticket would call.
 *   2. `engagements.deleted_at` IS NOT CONSULTED. A review whose ENGAGEMENT is soft-deleted
 *      keeps feeding the public rating, and nothing would trigger a recompute if one were.
 *      Latent for the same reason: `softDeleteEngagementTx` has no production caller. If
 *      either gains one, this fragment needs a join to `engagements` AND that writer needs
 *      to call the recompute — changing only one of the two silently drifts the aggregate.
 *
 * ⚠ THE EMPTY SET IS CORRECT FOR FREE, so do not add a special case. With zero live
 * reviews this yields ZERO rows; an aggregate over zero rows still returns exactly one
 * row, so the outer `avg` is NULL and the outer `count(*)` is 0 — precisely the
 * "no reviews ⇒ NULL, never 0.0" rule.
 *
 * The `drizzle-schema` skill says "no raw SQL when Drizzle can express it". This IS
 * Drizzle-composed — a builder-produced subquery, not a hand-written `execute()` string
 * — so a reviewer seeing `sql` here is looking at composition, not an escape hatch.
 */
function perEngagementAverages(expertProfileId: string) {
  return queryBuilder
    .select({
      engagementAverage: sql<string>`avg(${reviews.rating})`.as('engagement_average'),
    })
    .from(reviews)
    .where(and(eq(reviews.expertProfileId, expertProfileId), isNull(reviews.deletedAt)))
    .groupBy(reviews.engagementId);
}

/**
 * The derived table {@link recomputeRatingAggregate} joins, and its two output columns.
 * Named once so the `.as(…)` that DECLARES each name and the `SET` expression that READS
 * it cannot drift apart into a runtime "column does not exist".
 */
const AGGREGATE_ALIAS = 'rating_aggregate';
const AGGREGATE_AVERAGE_COLUMN = 'average';
const AGGREGATE_COUNT_COLUMN = 'engagement_count';

/** `"rating_aggregate"."<column>"` — a reference that cannot become ambiguous. */
function aggregateColumn(column: string) {
  return sql`${sql.identifier(AGGREGATE_ALIAS)}.${sql.identifier(column)}`;
}

/**
 * Recompute BOTH denormalised columns on `expert_profiles` FROM SCRATCH and write them.
 * Returns what was stored. Idempotent, and safe to call for an expert with no reviews.
 *
 * ⚠⚠ THE ROW LOCK MUST PRECEDE THE AGGREGATE READ, AND BOTH MUST SIT IN ONE TRANSACTION.
 * NEITHER IS DEFENSIVE POLISH — without them this is a textbook LOST UPDATE under READ
 * COMMITTED, and BAL-422's ticket originally claimed the opposite ("a full recompute reads
 * the current row set, so two racing transactions each converge on the correct value").
 * That claim is FALSE. Walk it:
 *
 *   1. T1 inserts a review on engagement A, then runs the aggregate. Its snapshot sees
 *      its own uncommitted row plus committed rows — NOT T2's.
 *   2. T2 inserts a review on engagement B, then runs the aggregate. Same: it cannot see
 *      T1's row.
 *   3. Both UPDATE `expert_profiles`. T2 blocks on T1's row lock, T1 commits, T2 proceeds
 *      and writes THE AGGREGATE IT COMPUTED IN STEP 2 — which never included T1's review.
 *
 * The stored average then silently omits a review and NOTHING detects it. The review
 * INSERT provides no help: the partial unique arbiter only serialises writes to the SAME
 * (engagement, reviewer, expert) triple, so two different engagements — the common case —
 * never contend there.
 *
 * ⚠ AND FUSING COMPUTE INTO THE `UPDATE` — which is already the shape below — DOES NOT
 * SAVE IT. That is worth stating precisely, because the obvious "repair" is to drop the
 * lock on the grounds that there is only one statement. Under READ COMMITTED, when a
 * blocked `UPDATE` is finally granted the row it re-checks the tuple through EvalPlanQual
 * — and EvalPlanQual re-evaluates ONLY THE `WHERE` QUAL against the updated tuple. The
 * aggregate here is an UNCORRELATED subquery in the target list, i.e. an InitPlan: it was
 * evaluated ONCE, at the start of the command, under that command's ORIGINAL snapshot, and
 * it is NOT recomputed when the lock is granted. So the stale value is written anyway.
 * (Contrast `scheduled_notifications.claim`, which is safe without a lock precisely because
 * its guard lives in the `WHERE` qual, which EvalPlanQual DOES re-check.)
 *
 * Taking the lock FIRST fixes it in one line of ordering: T2 cannot reach the aggregate
 * until T1 has committed and released. Under READ COMMITTED each STATEMENT takes a fresh
 * snapshot, so T2's aggregate — issued after the lock is granted — sees T1's committed
 * review. Both transactions write a value computed over a row set that includes the
 * other. Self-healing, as intended.
 *
 * ⚠⚠ `FOR NO KEY UPDATE`, NOT `FOR UPDATE` — AND THE DIFFERENCE IS A PRODUCTION OUTAGE,
 * NOT A STYLE CHOICE. Postgres's referential-integrity trigger takes `FOR KEY SHARE` on
 * the PARENT row for EVERY insert into a table that FKs `expert_profiles` — `engagements`,
 * `credit_sessions`, `consultations`, `availability_rules`, `availability_overrides`,
 * `calendar_connections`. `FOR UPDATE` CONFLICTS with `FOR KEY SHARE`, so a review write
 * holding it would block `openSession` (a live consultation start), engagement creation and
 * availability writes for that expert, for the life of the transaction. `FOR NO KEY UPDATE`
 * conflicts with ITSELF — which is the entire requirement, since the only writer being
 * serialised here is another copy of THIS function — while leaving `FOR KEY SHARE` alone.
 * The lost-update fix is therefore fully preserved and the money path is not on it. The
 * aggregate reads only `reviews`, so excluding readers of `expert_profiles` buys nothing.
 *
 * ⚠⚠ THE `executor.transaction(…)` WRAPPER IS PART OF THE LOCK, NOT BOILERPLATE. A row
 * lock lives until the end of its TRANSACTION. Called at its own default (`db`), the
 * `SELECT … FOR NO KEY UPDATE` would run in AUTOCOMMIT — its own implicit transaction —
 * and the lock would be released at STATEMENT end, before the `UPDATE` ever takes its
 * snapshot. Every guarantee above would evaporate SILENTLY. Wrapping means a `Database`
 * gets a real transaction and a `Transaction` gets a SAVEPOINT (row locks taken in a
 * subtransaction are retained by the parent on RELEASE), so the lock spans both statements
 * regardless of who calls and how. Same reasoning as `upsert`'s own wrapper.
 *
 * ⚠ LOCK ORDERING, for whoever adds the second writer: the lock is taken at the TOP of
 * the recompute, i.e. AFTER the review insert. Order is `reviews → expert_profiles`,
 * uniformly, so no cycle is constructible today. Keep that order.
 *
 * ⚠ THE PROOF IS A TEST, NOT THIS PROSE. `reviews.concurrency.integration.test.ts` forces
 * the interleaving on real backends and gates on `pg_blocking_pids()`. Delete the
 * `.for('no key update')` below and that file goes red TWO different ways — the forced case
 * on the VALUE (`1.0 / 1` instead of `3.0 / 2`, the lost update caught in the act) and the
 * mechanism case on "never observed blocked on its locking read". See that file's header;
 * it, not this comment, is the authority on which case fails how.
 *
 * ⚠ NO SOFT-DELETE GUARD ON THE `WHERE id = …`, DELIBERATELY. `expert_profiles` uses
 * `...timestamps` only and has NO `deleted_at` column; a "helpful" `isNull(deletedAt)`
 * will not compile.
 *
 * ⚠ IT IS EXPORTED, BUT NOT SO CALLERS CAN CHOOSE. `upsert` calls it UNCONDITIONALLY as
 * the last step inside its own transaction — there is no flag, no option and no early
 * return that can skip it. It is exported so (a) the soft-delete integration test can
 * drive it directly and (b) a FUTURE MODERATION PATH has a ready seam instead of
 * inventing a second aggregate. There is NO moderation write path today: nothing in this
 * repository or anywhere else in the codebase ever sets `reviews.deleted_at` (verified),
 * so the hook deliberately SHIPS AHEAD OF ITS CALLER. That gap is documented, not
 * discovered — building an unmounted, unauthorized admin mutation here was refused.
 */
async function recomputeRatingAggregate(
  expertProfileId: string,
  executor: DbExecutor = db
): Promise<{ ratingAverage: number | null; ratingCount: number }> {
  // ⚠ THE TRANSACTION IS LOAD-BEARING — see the ⚠⚠ above. Without it the lock below is
  // released at statement end and the two statements no longer share one lock scope.
  return executor.transaction(async (tx) => {
    // ── 1. SERIALISE ON THE EXPERT ROW FIRST. See the ⚠⚠ above; order is the fix. ──
    const [locked] = await tx
      .select({ id: expertProfiles.id })
      .from(expertProfiles)
      .where(eq(expertProfiles.id, expertProfileId))
      .for('no key update');
    if (locked === undefined) {
      // An integrity violation, not a normal miss: a review write named an expert profile
      // that does not exist, which the composite FK on `reviews` should make impossible.
      // `@balo/db` THROWS and the caller logs (the review write's existing catch already
      // does) — no log call is added here.
      throw new Error(`recomputeRatingAggregate: expert profile ${expertProfileId} not found`);
    }

    // ── 2. Compute AND write in ONE statement ⇒ ONE fresh READ COMMITTED snapshot, taken
    //       after the lock was granted, so it sees every committed racer.
    //
    // ⚠ ONE SCAN, NOT TWO — hence `UPDATE … FROM` rather than two scalar subqueries in the
    // `SET` list. Embedding {@link perEngagementAverages} once per column made every review
    // write run the grouped aggregate TWICE. Joining a single one-row derived table gives
    // both columns from one pass, and the semantics are identical: an aggregate with NO
    // `GROUP BY` returns EXACTLY ONE ROW even over an empty input, so this `FROM` can never
    // reduce the update to zero rows. (A grouped select here WOULD — do not add a
    // `GROUP BY` to `aggregate`.)
    //
    // ⚠ `count(*)` over the ALREADY-GROUPED derived table IS `count(distinct
    // engagement_id)`, and is cheaper. Do not "fix" it into a DISTINCT.
    const aggregate = queryBuilder
      .select({
        average: sql<string | null>`avg(engagement_average)`.as(AGGREGATE_AVERAGE_COLUMN),
        engagementCount: sql<number>`cast(count(*) as int)`.as(AGGREGATE_COUNT_COLUMN),
      })
      .from(perEngagementAverages(expertProfileId).as('per_engagement'))
      .as(AGGREGATE_ALIAS);

    const [row] = await tx
      .update(expertProfiles)
      .set({
        // ⚠ QUALIFIED ON PURPOSE. Interpolating `aggregate.average` directly emits a BARE
        // `"average"`, which resolves against the whole `UPDATE … FROM` range table — fine
        // today, but it would become an ambiguity error the day `expert_profiles` gained a
        // column of either name. `aggregateColumn` pins the reference to the derived table.
        ratingAverage: aggregateColumn(AGGREGATE_AVERAGE_COLUMN),
        ratingCount: aggregateColumn(AGGREGATE_COUNT_COLUMN),
        updatedAt: sql`now()`,
      })
      .from(aggregate)
      .where(eq(expertProfiles.id, expertProfileId))
      .returning({
        ratingAverage: expertProfiles.ratingAverage,
        ratingCount: expertProfiles.ratingCount,
      });
    if (row === undefined) {
      throw new Error(`recomputeRatingAggregate: expert profile ${expertProfileId} vanished`);
    }

    // `rating_average` is `numeric` ⇒ Drizzle hands back a STRING. One parse, in one place.
    return {
      ratingAverage: parseRatingAverage(row.ratingAverage),
      ratingCount: row.ratingCount,
    };
  });
}

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
  /**
   * What the in-transaction recompute STORED in `expert_profiles.rating_count` — ENGAGEMENTS
   * REVIEWED, not review rows.
   *
   * ⚠ IT IS DRIFT TELEMETRY, NOT A RETURN VALUE ANYONE ACTS ON (BAL-422). `applyReview` logs
   * it on the "Review submitted" line so an operator can compare the stored aggregate against
   * the review rows without a query. Surfacing it here — rather than re-reading the column a
   * layer out — is the point: this number is the one the write actually committed, so a log
   * line carrying it cannot disagree with the row.
   */
  ratingCount: number;
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
 * expert), plus the reads the nudge sweep, the magic-link landing and the public
 * surface need, plus (BAL-422) the recompute of the denormalised rating aggregate on
 * `expert_profiles`.
 *
 * ⚠ `listPublicByExpert` REMAINS UNMOUNTED. BAL-422 mounts the AGGREGATE (the number and
 * the count), not review BODIES — those stay out of scope and nothing renders them yet.
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
   *
   * ⚠ BAL-422: THAT SAME TRANSACTION NOW ALSO RECOMPUTES `expert_profiles.rating_average`
   * / `rating_count`, unconditionally, as its LAST step. The recompute must not be
   * hoisted to the application layer: `review-write-shared.ts` awaits this call OUTSIDE
   * any transaction, so hooking there would make "recompute in the same transaction as
   * the review write" unsatisfiable and would leave the aggregate permanently drifted
   * whenever the process died between the two awaits. Note the `FOR NO KEY UPDATE` inside
   * the recompute lands AFTER the insert above — that lock order (`reviews` →
   * `expert_profiles`) is uniform and must stay that way.
   *
   * ⚠ THE RECOMPUTE OPENS A NESTED TRANSACTION, i.e. a SAVEPOINT on this one. That is
   * deliberate (it is what makes the recompute's lock scope correct when it is called
   * standalone) and it costs this path nothing: a SAVEPOINT released inside an open
   * transaction RETAINS the row locks taken under it, so the expert-row lock still lives
   * until THIS transaction commits.
   *
   * The OPTIONAL trailing executor (the `scheduledNotificationsRepository` house pattern)
   * exists so `reviews.concurrency.integration.test.ts` can drive THIS function — the
   * real write path — on its own Postgres connection. Production passes nothing. Note it
   * still opens a transaction either way: on a `Database` that is a real one, on a
   * transaction handle it is a SAVEPOINT, and both keep the review, the audit row and the
   * recompute atomic together.
   */
  upsert: async (
    input: UpsertReviewInput,
    executor: DbExecutor = db
  ): Promise<UpsertReviewResult> => {
    return executor.transaction(async (tx) => {
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

      // ⚠ UNCONDITIONAL, LAST, AND INSIDE THIS TRANSACTION. There is no flag and no
      // early return that can skip it, so the aggregate cannot drift from the rows.
      // Covers the UPDATE branch too: a REVISED rating recomputes from scratch, which is
      // exactly the case an insert-only or delta hook silently gets wrong.
      // If this throws, the review and its audit row roll back with it — correct: a
      // review that is not reflected in the aggregate would be invisible on every surface.
      const { ratingCount } = await recomputeRatingAggregate(input.expertProfileId, tx);

      return { review: row, created, ratingCount };
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
   *
   * ⚠ THIS IS NOT THE NUDGE SUPPRESSION, AND IT IS NOT A BACKSTOP FOR IT. The sweep's
   * candidate queries already drop an engagement the moment ANY live review exists for
   * `(engagement, expert)` — engagement-level, no reviewer predicate, ratified 2026-08-06.
   * So by the time this function runs, NOBODY on this engagement has rated; once someone
   * has, the engagement never reaches it. Its only live function is the sub-second race of
   * a review landing between the candidate SELECT and the publish inside one tick.
   *
   * It can only NARROW the list it is handed, never widen it — so it cannot resurrect a
   * participant the SQL already excluded. If per-participant nudging is ever wanted, this
   * function becomes the sole suppression (drop the readers' `NOT EXISTS`); it is already
   * shaped for that, which is why it survives despite being near-dead today.
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
   * The expert's rating aggregate computed LIVE from `reviews` — the same two-level
   * shape `recomputeRatingAggregate` stores, wrapping the SAME
   * {@link perEngagementAverages} fragment, but UN-ROUNDED.
   *
   * ⚠ THE WEIGHTING WAS DECIDED, NOT LEFT OPEN (BAL-422, Yomi 2026-08-14): ONE
   * ENGAGEMENT, ONE VOTE. `averageRating` is the average of per-engagement averages and
   * `ratedEngagementCount` is the number of ENGAGEMENTS REVIEWED — never the number of
   * review rows. This replaced the flat per-row AVG that used to live here.
   *
   * ⚠ THE RETURN KEY IS `ratedEngagementCount`, NOT `count`, AND THE MISMATCH WITH
   * `expert_profiles.rating_count` IS DELIBERATE. The AC pins the column name, so the
   * anti-misreading work has to be carried at the seam instead: the word "engagement"
   * appears at every call site, and a reader who notices the two names differ is meant
   * to stop and check which one they are holding. They are the same quantity.
   *
   * ⚠ IT IS NOT THE DISPLAY PATH. Surfaces read the DENORMALISED columns — that is why
   * they exist (expert search returns many experts per page, and a per-expert aggregate
   * at read time is high fan-out on the hottest path in the product). This function's
   * standing job is ANTI-DRIFT: an integration test asserts that rounding this to 1dp
   * equals the stored `rating_average` across every fixture, which is what keeps the read
   * and the write from diverging.
   *
   * `deleted_at IS NULL` is the ONLY filter — NO status filter, NO terminal-state gate,
   * NO frozen window: a review counts immediately. Rides `review_expert_live_idx`, whose
   * column order (`expert_profile_id, engagement_id, rating`) exists for this GROUP BY.
   */
  aggregateForExpert: async (
    expertProfileId: string,
    executor: DbExecutor = db
  ): Promise<{ ratedEngagementCount: number; averageRating: number | null }> => {
    const perEngagement = perEngagementAverages(expertProfileId).as('per_engagement');

    const [row] = await executor
      .select({
        ratedEngagementCount: sql<number>`cast(count(*) as int)`,
        // ⚠ `numeric`, so this arrives as a STRING and is parsed below — NOT `::float8`.
        // The read must not round or binary-approximate where the write does not.
        averageRating: sql<string | null>`avg(engagement_average)`,
      })
      .from(perEngagement);

    return {
      ratedEngagementCount: row?.ratedEngagementCount ?? 0,
      averageRating: parseRatingAverage(row?.averageRating ?? null),
    };
  },

  /** See {@link recomputeRatingAggregate} — the ⚠⚠ lock ordering / strength lives there. */
  recomputeRatingAggregate,

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
   * Ships and is tested; NOTHING MOUNTS IT, and BAL-422 did not change that. BAL-422
   * mounts the AGGREGATE (`expert_profiles.rating_average` / `rating_count`) — review
   * BODIES are explicitly out of its scope, so this still has no caller and no ticket
   * owns mounting it.
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
