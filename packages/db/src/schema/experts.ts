import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  numeric,
  timestamp,
  date,
  uniqueIndex,
  index,
  check,
  customType,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { expertTypeEnum, applicationStatusEnum, languageProficiencyEnum } from './enums';
import { users } from './users';
import { agencies } from './agencies';
import { verticals, products, supportTypes, certifications } from './verticals';
import { languages } from './languages';
import { industries } from './industries';
import { expertPayoutDetails } from './payouts';
import { calendarConnections } from './calendar';
import { timestamps } from './helpers';

/**
 * Postgres `tsvector` custom type for full-text search. Never selected or
 * written directly from application code — it is matched/ranked exclusively via
 * raw `sql` FTS expressions in the expert-search repository. Declared here only
 * so drizzle-kit is aware of the generated column and does not try to drop it.
 */
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

export const expertProfiles = pgTable(
  'expert_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .references(() => users.id)
      .notNull(),
    verticalId: uuid('vertical_id')
      .references(() => verticals.id)
      .notNull(),

    type: expertTypeEnum('type').notNull(),
    agencyId: uuid('agency_id').references(() => agencies.id),

    headline: text('headline'),
    bio: text('bio'),
    username: text('username'),
    rateCents: integer('rate_cents'),

    trailheadUrl: text('trailhead_url'),
    linkedinUrl: text('linkedin_url'),
    websiteUrl: text('website_url'),

    availableForWork: boolean('available_for_work').default(true).notNull(),

    stripeConnectId: text('stripe_connect_id'),

    searchable: boolean('searchable').default(false).notNull(),
    skillsLocked: boolean('skills_locked').default(false).notNull(),

    // Experience metrics
    yearStartedSalesforce: integer('year_started_salesforce'),
    // Stores the lower bound of the selected range.
    // UI ranges → stored value: None=0, 1-9=1, 10-25=10, 26-50=26, 50+=50
    // Display logic maps the stored value back to the range label.
    projectCountMin: integer('project_count_min'),
    projectLeadCountMin: integer('project_lead_count_min'),

    // Salesforce distinctions
    isSalesforceMvp: boolean('is_salesforce_mvp').default(false).notNull(),
    isSalesforceCta: boolean('is_salesforce_cta').default(false).notNull(),
    isCertifiedTrainer: boolean('is_certified_trainer').default(false).notNull(),

    // Application lifecycle
    applicationStatus: applicationStatusEnum('application_status').default('draft').notNull(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),

    // Calendar / availability
    timezone: text('timezone').notNull().default('UTC'),

    // Booking rules (BAL-234) — scalar 1:1 settings fed into the availability
    // resolver. Stored here (not a separate table) since there is exactly one set
    // per expert. Constant NOT NULL defaults → PG11+ fast metadata-only add.
    // Bounds enforced both here (CHECK) and in the API/action Zod. No
    // booking-window column: the look-ahead horizon is platform config (BAL-398),
    // not a per-expert setting.
    bookingBufferBeforeMinutes: integer('booking_buffer_before_minutes').notNull().default(0),
    bookingBufferAfterMinutes: integer('booking_buffer_after_minutes').notNull().default(0),
    bookingMinimumNoticeMinutes: integer('booking_minimum_notice_minutes').notNull().default(0),

    // ── Denormalised rating roll-up (BAL-422) ────────────────────────────────
    /**
     * The expert's average rating, or NULL.
     *
     * ⚠ NULLABLE, AND NULL MEANS "NO REVIEWS" — NEVER 0.0. No surface may render 0.0:
     * the scale starts at 1, so a zero is not a bad rating, it is a fabricated one.
     * Every reader null-gates on THIS column (never on `rating_count`).
     *
     * STORED rather than derived on read because expert search returns many experts per
     * page and every row needs a rating — a per-expert aggregate at read time is high
     * fan-out on the hottest path in the product. It is recomputed FROM SCRATCH (never
     * incrementally) inside the same transaction as every review write; see
     * `reviewsRepository.recomputeRatingAggregate`, which is the ONLY writer.
     *
     * ⚠ THE AVERAGE IS OF PER-ENGAGEMENT AVERAGES, not of review rows — see
     * `ratingCount` below for the ruling and why it matters.
     *
     * ⚠ numeric(2,1). THE ROUNDING TO ONE DECIMAL HAPPENS EXACTLY ONCE, HERE, ON
     * ASSIGNMENT. The per-engagement averages feeding it are exact `numeric` (Postgres
     * `avg()` over `integer` returns `numeric`, not `float8`) and are NEVER rounded
     * first — round each engagement and the four-row fixture `[5,5,4]` + `[4]` stores
     * 4.4 instead of the correct 4.3. `reviews.integration.test.ts` pins that exact
     * discrimination; do not "simplify" it away.
     *
     * ⚠ DRIZZLE INFERS `numeric` AS `string`, NOT `number`. Reads arrive as `'4.3'`.
     * Every projection of this column goes through `parseRatingAverage`
     * (`@balo/shared/reviews`) — never a per-call-site `Number(...)`, never a `::float8`
     * cast in the projection.
     */
    ratingAverage: numeric('rating_average', { precision: 2, scale: 1 }),

    /**
     * ENGAGEMENTS REVIEWED — **NOT** `count(*)` over `reviews`.
     *
     * ⚠ ONE ENGAGEMENT, ONE VOTE (Yomi, 2026-08-14). The partial unique on `reviews`
     * permits one live review per (engagement, reviewer, expert), so a 5-member company
     * can contribute FIVE rows to ONE engagement where a 1-person company contributes
     * one. This column counts the DISTINCT engagements that carry at least one live
     * review — in that example, 1, not 5. `rating_average` is the average of
     * per-engagement averages, weighted to match.
     *
     * A rating is a statement by the PARTY, not by each person who happened to be on the
     * call — the same ruling BAL-390 already made for review BODIES
     * (`listPublicByExpert` projects `companies.name` and can never project the
     * reviewer). This makes the NUMBER agree with it.
     *
     * ⚠ NEVER derive this from `select count(*) from reviews where expert_profile_id = …`.
     * That is the flat per-row count this decision REJECTED, and it overstates the
     * evidence — "(6)" reads as six clients when there were two. Both columns are
     * recomputed together and only by `reviewsRepository.recomputeRatingAggregate`.
     *
     * NOT NULL with a CONSTANT default → PG11+ metadata-only add, no table rewrite.
     */
    ratingCount: integer('rating_count').notNull().default(0),

    ...timestamps,
    approvedAt: timestamp('approved_at', { withTimezone: true }),

    // Generated STORED full-text search vector: headline weight A, bio weight B.
    // Postgres maintains this automatically on every expert_profiles write — no
    // trigger code, no drift. Product names (weight C) are folded in at query time
    // by the expert-search repository, not stored here. Never read/written
    // directly via Drizzle (excluded from $inferInsert by .generatedAlwaysAs).
    searchVector: tsvector('search_vector').generatedAlwaysAs(
      sql`setweight(to_tsvector('english', coalesce(headline, '')), 'A') || setweight(to_tsvector('english', coalesce(bio, '')), 'B')`
    ),
  },
  (table) => ({
    userVerticalIdx: uniqueIndex('expert_user_vertical_idx').on(table.userId, table.verticalId),
    usernameIdx: uniqueIndex('expert_profiles_username_idx').on(table.username),
    searchVectorIdx: index('expert_profiles_search_vector_idx').using('gin', table.searchVector),
    // BAL-356: FK index on the payout-agency link (index-all-FKs) — powers the
    // "experts by agency" / payout-entity lookups. `agencyId` is set by
    // expertsRepository.linkAgency for all three agency-resolution outcomes.
    agencyIdx: index('expert_profiles_agency_id_idx').on(table.agencyId),
    // Booking-rule bounds (BAL-234) — mirrored by Zod in the schedule route/action.
    bookingBufferBeforeCheck: check(
      'expert_profiles_booking_buffer_before_check',
      sql`${table.bookingBufferBeforeMinutes} BETWEEN 0 AND 120`
    ),
    bookingBufferAfterCheck: check(
      'expert_profiles_booking_buffer_after_check',
      sql`${table.bookingBufferAfterMinutes} BETWEEN 0 AND 120`
    ),
    bookingMinimumNoticeCheck: check(
      'expert_profiles_booking_minimum_notice_check',
      sql`${table.bookingMinimumNoticeMinutes} BETWEEN 0 AND 20160`
    ),
    // ── Rating roll-up bounds (BAL-422) ──────────────────────────────────────
    // The range a two-level average over a 1..5 scale can actually produce. NULL is
    // legal and is the "no reviews" reading; 0.0 is NOT, which is the point — it is the
    // one value the recompute must never store and every surface must never render.
    //
    // ⚠ WHAT THIS CANNOT CATCH: a regression to the FLAT per-row average still lands in
    // [1,5] and passes. Only the `4.3 vs 4.4 vs 4.5` fixture in
    // `reviews.integration.test.ts` catches that. What it DOES catch is a sum/count
    // transposition or a divide-by-the-wrong-denominator, which escapes the range fast.
    ratingAverageRangeCheck: check(
      'expert_profiles_rating_average_range',
      sql`${table.ratingAverage} IS NULL OR (${table.ratingAverage} >= 1.0 AND ${table.ratingAverage} <= 5.0)`
    ),
    ratingCountNonNegativeCheck: check(
      'expert_profiles_rating_count_non_negative',
      sql`${table.ratingCount} >= 0`
    ),
  })
);

export const expertCompetency = pgTable(
  'expert_competency',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    expertProfileId: uuid('expert_profile_id')
      .references(() => expertProfiles.id)
      .notNull(),
    // FK-references products.id (the taxonomy product this competency is in).
    productId: uuid('product_id')
      .references(() => products.id)
      .notNull(),
    supportTypeId: uuid('support_type_id')
      .references(() => supportTypes.id)
      .notNull(),

    proficiency: integer('proficiency').notNull().default(0),

    ...timestamps,
  },
  (table) => ({
    uniqueCompetencyIdx: uniqueIndex('expert_competency_unique_idx').on(
      table.expertProfileId,
      table.productId,
      table.supportTypeId
    ),
  })
);

export const expertCertifications = pgTable(
  'expert_certifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    expertProfileId: uuid('expert_profile_id')
      .references(() => expertProfiles.id)
      .notNull(),
    certificationId: uuid('certification_id')
      .references(() => certifications.id)
      .notNull(),

    earnedAt: date('earned_at'),
    expiresAt: date('expires_at'),
    credentialUrl: text('credential_url'),

    ...timestamps,
  },
  (table) => ({
    expertCertIdx: uniqueIndex('expert_cert_unique_idx').on(
      table.expertProfileId,
      table.certificationId
    ),
  })
);

export const expertLanguages = pgTable(
  'expert_languages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    expertProfileId: uuid('expert_profile_id')
      .references(() => expertProfiles.id, { onDelete: 'cascade' })
      .notNull(),
    languageId: uuid('language_id')
      .references(() => languages.id, { onDelete: 'restrict' })
      .notNull(),

    proficiency: languageProficiencyEnum('proficiency').notNull(),

    ...timestamps,
  },
  (table) => ({
    expertLangUniqueIdx: uniqueIndex('expert_lang_unique_idx').on(
      table.expertProfileId,
      table.languageId
    ),
    expertProfileIdx: index('expert_lang_profile_idx').on(table.expertProfileId),
    languageIdx: index('expert_lang_language_idx').on(table.languageId),
  })
);

export const expertIndustries = pgTable(
  'expert_industries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    expertProfileId: uuid('expert_profile_id')
      .references(() => expertProfiles.id, { onDelete: 'cascade' })
      .notNull(),
    industryId: uuid('industry_id')
      .references(() => industries.id, { onDelete: 'restrict' })
      .notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    expertIndustryUniqueIdx: uniqueIndex('expert_industry_unique_idx').on(
      table.expertProfileId,
      table.industryId
    ),
    expertProfileIdx: index('expert_industry_profile_idx').on(table.expertProfileId),
    industryIdx: index('expert_industry_industry_idx').on(table.industryId),
  })
);

export const workHistory = pgTable(
  'work_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    expertProfileId: uuid('expert_profile_id')
      .references(() => expertProfiles.id, { onDelete: 'cascade' })
      .notNull(),

    role: text('role').notNull(),
    company: text('company').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    isCurrent: boolean('is_current').default(false).notNull(),
    responsibilities: text('responsibilities'),

    sortOrder: integer('sort_order').default(0).notNull(),

    ...timestamps,
  },
  (table) => ({
    expertProfileIdx: index('work_history_profile_idx').on(table.expertProfileId),
    sortIdx: index('work_history_sort_idx').on(table.expertProfileId, table.sortOrder),
  })
);

// Relations
export const expertProfilesRelations = relations(expertProfiles, ({ one, many }) => ({
  user: one(users, {
    fields: [expertProfiles.userId],
    references: [users.id],
  }),
  vertical: one(verticals, {
    fields: [expertProfiles.verticalId],
    references: [verticals.id],
  }),
  agency: one(agencies, {
    fields: [expertProfiles.agencyId],
    references: [agencies.id],
  }),
  competencies: many(expertCompetency),
  certifications: many(expertCertifications),
  languages: many(expertLanguages),
  industries: many(expertIndustries),
  workHistory: many(workHistory),
  payoutDetails: one(expertPayoutDetails, {
    fields: [expertProfiles.id],
    references: [expertPayoutDetails.expertProfileId],
  }),
  /**
   * ⚠⚠ D1 (BAL-467 review WARNING) — WAS `calendarConnection: one(calendarConnections, …)`.
   * Under ADR-1021's 18-Aug-2026 amendment §1 an expert may hold TWO live connections (one
   * per provider), so a singular `one()` relation named a row ARBITRARILY-of-N and applied
   * no `deleted_at` filter — it could surface a disconnected connection too. This sat
   * outside `repositories/calendar.ts`'s per-method cardinality audit AND outside
   * `calendar-connection-cardinality.test.ts`'s reach (that file only reads the table and
   * the repository, not this one). Renamed to `many()` — plural, so `with: {
   * calendarConnections: true }` reads correctly and a future caller cannot reach for the
   * old singular name without the type actually changing shape under them. No `deleted_at`
   * filter is applied here either; a caller wanting only LIVE connections must filter after
   * hydrating, same as `listConnectionsByExpertProfileId` in the repository.
   *
   * There are no current consumers (grepped before renaming) — this relation is unused.
   */
  calendarConnections: many(calendarConnections),
}));

export const expertCompetencyRelations = relations(expertCompetency, ({ one }) => ({
  expertProfile: one(expertProfiles, {
    fields: [expertCompetency.expertProfileId],
    references: [expertProfiles.id],
  }),
  // Relation to the product this competency is in (referenced by
  // `with: { product: … }` query usages).
  product: one(products, {
    fields: [expertCompetency.productId],
    references: [products.id],
  }),
  supportType: one(supportTypes, {
    fields: [expertCompetency.supportTypeId],
    references: [supportTypes.id],
  }),
}));

export const expertCertificationsRelations = relations(expertCertifications, ({ one }) => ({
  expertProfile: one(expertProfiles, {
    fields: [expertCertifications.expertProfileId],
    references: [expertProfiles.id],
  }),
  certification: one(certifications, {
    fields: [expertCertifications.certificationId],
    references: [certifications.id],
  }),
}));

export const expertLanguagesRelations = relations(expertLanguages, ({ one }) => ({
  expertProfile: one(expertProfiles, {
    fields: [expertLanguages.expertProfileId],
    references: [expertProfiles.id],
  }),
  language: one(languages, {
    fields: [expertLanguages.languageId],
    references: [languages.id],
  }),
}));

export const expertIndustriesRelations = relations(expertIndustries, ({ one }) => ({
  expertProfile: one(expertProfiles, {
    fields: [expertIndustries.expertProfileId],
    references: [expertProfiles.id],
  }),
  industry: one(industries, {
    fields: [expertIndustries.industryId],
    references: [industries.id],
  }),
}));

export const workHistoryRelations = relations(workHistory, ({ one }) => ({
  expertProfile: one(expertProfiles, {
    fields: [workHistory.expertProfileId],
    references: [expertProfiles.id],
  }),
}));

export type ExpertProfile = typeof expertProfiles.$inferSelect;
export type NewExpertProfile = typeof expertProfiles.$inferInsert;
export type ExpertCompetency = typeof expertCompetency.$inferSelect;
export type NewExpertCompetency = typeof expertCompetency.$inferInsert;
export type ExpertCertification = typeof expertCertifications.$inferSelect;
export type NewExpertCertification = typeof expertCertifications.$inferInsert;
export type ExpertLanguage = typeof expertLanguages.$inferSelect;
export type NewExpertLanguage = typeof expertLanguages.$inferInsert;
export type ExpertIndustry = typeof expertIndustries.$inferSelect;
export type NewExpertIndustry = typeof expertIndustries.$inferInsert;
export type WorkHistory = typeof workHistory.$inferSelect;
export type NewWorkHistory = typeof workHistory.$inferInsert;
