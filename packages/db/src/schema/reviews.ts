import {
  pgTable,
  uuid,
  integer,
  text,
  timestamp,
  index,
  uniqueIndex,
  check,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { reviewSurfaceEnum, reviewAuthMethodEnum } from './enums';
import { engagements } from './engagements';
import { users } from './users';
import { expertProfiles } from './experts';
import { timestamps, softDelete } from './helpers';

/**
 * reviews (BAL-390) — one client-side rating (and optional plain-text body) of the
 * expert who delivered an ENGAGEMENT.
 *
 * THE REVIEWABLE UNIT IS THE ENGAGEMENT SUPERTYPE — a Project or a Case, never a
 * meeting, never a `credit_session`. A Case may run many consultations; the client
 * rates the engagement, not each call.
 *
 * ONE LIVE REVIEW PER (engagement, reviewer, expert), enforced by a PARTIAL unique
 * index so a moderated (soft-deleted) review frees the slot instead of permanently
 * locking that reviewer out. The write path is an UPSERT against that index — see the
 * ⚠⚠ `targetWhere` warning on it, which is the single most likely way to break this table.
 *
 * NO RLS — matches every table in this package (rationale docblock at
 * `proposal-share-links.ts`): Balo auths with WorkOS + iron-session, not Supabase Auth,
 * so `auth.uid()` is meaningless; authorization lives in the app layer (ADR-1029).
 */
export const reviews = pgTable(
  'reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * The engagement being reviewed. Declared WITHOUT an inline `.references()` — the
     * COMPOSITE FK below (`review_engagement_expert_fk`) carries the reference and the
     * `ON DELETE cascade`, exactly as `case_engagements.engagement_id` does.
     */
    engagementId: uuid('engagement_id').notNull(),

    /**
     * ATTRIBUTION — the PERSON who wrote it. `restrict` per ADR-1030 and the
     * `proposal_share_links` / `expert_referral_invites` treatment: the actor must
     * survive their own departure from the company.
     *
     * ⚠ D6: THE PUBLIC PROJECTION COLLAPSES TO THE CLIENT COMPANY. A published review
     * is a PARTY statement, not a personal one — `reviewsRepository.listPublicByExpert`
     * selects `companies.name` and an invariant test asserts this column can never
     * appear in that projection. NEVER widen a public read to select it.
     */
    reviewerUserId: uuid('reviewer_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    /**
     * The review SUBJECT, denormalised from `engagements.expert_profile_id` AT WRITE
     * TIME (never from client input) so the aggregate read is a single-table index scan
     * and the unique key is the ticket's stated TRIPLE. Coherence with the engagement is
     * STRUCTURAL, not conventional — see `review_engagement_expert_fk`.
     */
    expertProfileId: uuid('expert_profile_id').notNull(),

    /** 1..5. Enforced by `review_rating_range`; the caller Zod-validates on top. */
    rating: integer('rating').notNull(),

    /**
     * ⚠ PLAIN TEXT. NEVER HTML.
     *
     * Do NOT call `sanitizeProjectHtml` on it, do not store markup, render it as text
     * (React escapes). Precedent: `action_items.body`. THE TRAP: the sibling
     * `case_engagements.description` IS sanitised HTML and sits one table away — this
     * column is deliberately not it, and a writer who "helpfully" sanitises here is
     * storing markup that some future renderer will be tempted to `dangerouslySetInnerHTML`.
     */
    body: text('body'),

    /** WHERE it was captured. */
    surface: reviewSurfaceEnum('surface').notNull(),

    /** HOW the writer authenticated — orthogonal to `surface`. See the enum docblock. */
    authMethod: reviewAuthMethodEnum('auth_method').notNull(),

    /**
     * NULL on the INSERT branch of the upsert, stamped on every UPDATE branch. This is
     * the created/updated discriminator the analytics split reads — DETERMINISTIC, and
     * cheaper than a pre-read (which would race under READ COMMITTED).
     */
    lastEditedAt: timestamp('last_edited_at', { withTimezone: true }),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    check('review_rating_range', sql`${t.rating} >= 1 AND ${t.rating} <= 5`),
    // A whitespace-only body is a bug, not an opinion. NULL stays legal — rating-only
    // reviews are the common case.
    check(
      'review_body_nonempty_when_present',
      sql`${t.body} IS NULL OR length(btrim(${t.body})) > 0`
    ),

    // ── THE UPSERT ARBITER ───────────────────────────────────────────────────────
    // ONE live review per (engagement, reviewer, expert). PARTIAL on `deleted_at IS NULL`
    // so a soft-deleted (moderated) review frees the slot rather than permanently
    // blocking the reviewer — the documented `reference_softdelete_nonpartial_unique_recreate`
    // failure mode.
    //
    // ⚠⚠ THE REPOSITORY UPSERT MUST RESTATE THIS PREDICATE AS `targetWhere`. Postgres
    // only selects a PARTIAL index as the ON CONFLICT arbiter when the statement restates
    // its predicate; otherwise arbiter inference fails AT PLAN TIME and EVERY upsert —
    // including the very first — raises 42P10 ("there is no unique or exclusion constraint
    // matching the ON CONFLICT specification"). Typecheck stays green either way, so the
    // insert-then-update-in-place integration test is the only thing that catches it.
    uniqueIndex('review_engagement_reviewer_expert_live_idx')
      .on(t.engagementId, t.reviewerUserId, t.expertProfileId)
      .where(sql`${t.deletedAt} IS NULL`),

    // THE RECOMPUTE READ (BAL-422): AVG over PER-ENGAGEMENT AVGs, and a COUNT of
    // ENGAGEMENTS — not of rows — over LIVE rows for one expert. All three columns the
    // aggregate touches are in the index, so it is index-only.
    //
    // ⚠ COLUMN ORDER IS LOAD-BEARING, NOT ALPHABETICAL:
    //   expert_profile_id — the equality predicate, so it must lead;
    //   engagement_id     — the GROUP BY key, so the scan arrives PRE-SORTED and the
    //                       planner takes a GroupAggregate with NO sort node;
    //   rating            — the aggregated payload, carried only to stay index-only.
    // Dropping `engagement_id` (the shape before BAL-422) forces a sort or a HashAggregate
    // on every recompute, and every review write runs one.
    //
    // NO status filter, NO terminal-state gate, NO frozen window — a review counts
    // immediately. `deleted_at IS NULL` is the ONLY filter, and it is the partial
    // predicate rather than a column so a moderated row leaves the index entirely.
    index('review_expert_live_idx')
      .on(t.expertProfileId, t.engagementId, t.rating)
      .where(sql`${t.deletedAt} IS NULL`),

    // NON-PARTIAL and deliberately so: it must serve the composite FK's delete-time scan
    // (which sees soft-deleted rows too) as well as the review-absence check the nudge
    // sweep and the fused-email variant gate both run.
    index('review_engagement_expert_idx').on(t.engagementId, t.expertProfileId),

    // ⚠ DIVERGES from the BAL-417 actor-FK ruling (`case-engagements.ts`), which leaves
    // actor FKs unindexed on the premise that users are never hard-deleted. THAT PREMISE
    // IS FALSE HERE: `apps/web/src/app/admin-dev/_actions/delete-user.ts` HARD deletes
    // users (the reason `meeting_presence.user_id` is `set null`). A `restrict` FK whose
    // delete-time scan can actually run needs an index.
    index('review_reviewer_idx').on(t.reviewerUserId),

    // ── STRUCTURAL EXPERT COHERENCE ──────────────────────────────────────────────
    // A review whose `expert_profile_id` disagrees with its engagement's is IMPOSSIBLE AT
    // THE DATABASE, not merely discouraged — the same technique BAL-417 used for the
    // supertype/subtype pairing (`engagement_id_type_uq`). Requires the
    // `engagement_id_expert_uq` UNIQUE on `engagements`.
    foreignKey({
      columns: [t.engagementId, t.expertProfileId],
      foreignColumns: [engagements.id, engagements.expertProfileId],
      name: 'review_engagement_expert_fk',
    }).onDelete('cascade'),
  ]
);

// ── Relations ──────────────────────────────────────────────────────────

export const reviewsRelations = relations(reviews, ({ one }) => ({
  engagement: one(engagements, {
    fields: [reviews.engagementId],
    references: [engagements.id],
  }),
  reviewer: one(users, {
    fields: [reviews.reviewerUserId],
    references: [users.id],
  }),
  expertProfile: one(expertProfiles, {
    fields: [reviews.expertProfileId],
    references: [expertProfiles.id],
  }),
}));

// ── Type exports ───────────────────────────────────────────────────────

export type Review = typeof reviews.$inferSelect;
export type NewReview = typeof reviews.$inferInsert;

// NO schema-derived `ReviewSurface` / `ReviewAuthMethod` aliases are exported here, on
// purpose. `@balo/shared/reviews` owns those two unions (BAL-389's CLIENT component must
// import them without value-importing `@balo/db` — `reference_balo_db_client_bundle_footgun`),
// and `reviewsRepository`'s input types use the shared ones. Because `NewReview`'s
// inferred column types ARE the pgEnum literal unions, assigning a shared `ReviewSurface`
// into an insert only compiles while the two agree — the lockstep guard is the type
// checker, for free, with no duplicated union to drift.
