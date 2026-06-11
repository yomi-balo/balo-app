import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  unique,
  foreignKey,
  check,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import {
  requestExpertRelationshipStatusEnum,
  proposalStatusEnum,
  pricingMethodEnum,
  proposalCadenceEnum,
  proposalChangeSectionEnum,
  proposalDocumentKindEnum,
} from './enums';
import { projectRequests } from './project-requests';
import { expertProfiles } from './experts';
import { users } from './users';
import { timestamps, softDelete } from './helpers';

/**
 * Request origination spine (BAL-267 / epic BAL-266). The graph that sits behind
 * a submitted project request: per-expert relationships, expressions of interest,
 * proposals, and a per-relationship conversation (messages + files).
 *
 * `request_expert_relationships` is the per-expert spine: one row per
 * (request, expert), created at admin invite (`invited`), carrying that single
 * expert's own status. EOIs, proposals, messages, and files all FK to the
 * relationship and carry a denormalised `project_request_id` (and, where useful,
 * `expert_profile_id`) for indexed request-scoped reads.
 *
 * Rich text authored by users (`message`, `overview`, `body`) is server-sanitised
 * HTML — same contract as `project_requests.description`; sanitisation happens in
 * the web caller, never in @balo/db. Money is integer minor units (`price_cents`)
 * + `currency`, never floats (mirrors `expert_profiles.rate_cents`).
 */

/**
 * request_expert_relationships — the per-expert spine. Born at admin invite.
 * `projectRequestId`/`expertProfileId` CASCADE (children die with the request /
 * expert, mirroring project_requests.expert_profile_id); `invitedByUserId`
 * RESTRICT (preserve admin attribution, mirrors created_by_user_id).
 */
export const requestExpertRelationships = pgTable(
  'request_expert_relationships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectRequestId: uuid('project_request_id')
      .notNull()
      .references(() => projectRequests.id, { onDelete: 'cascade' }),
    expertProfileId: uuid('expert_profile_id')
      .notNull()
      .references(() => expertProfiles.id, { onDelete: 'cascade' }),
    status: requestExpertRelationshipStatusEnum('status').notNull().default('invited'),
    // The admin who invited this expert. Preserve attribution → restrict.
    invitedByUserId: uuid('invited_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    invitedAt: timestamp('invited_at', { withTimezone: true }).defaultNow().notNull(),
    declinedAt: timestamp('declined_at', { withTimezone: true }),
    // When the client requested a proposal (BAL-272). Stamped by the shared
    // transition on `eoi_submitted → proposal_requested`; survives later
    // transitions (unlike `updatedAt`) for the cap/swap mechanic, A6 "awaiting
    // since" surfaces, and reminder nudges. Read via the relationship row,
    // never filtered on → no index.
    proposalRequestedAt: timestamp('proposal_requested_at', { withTimezone: true }),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    // One LIVE relationship per (request, expert). PARTIAL on `deleted_at IS NULL`
    // (mirrors the status index below) so a removed (soft-deleted) expert can be
    // re-invited — the soft-deleted row no longer occupies the unique slot, while
    // live duplicates are still rejected.
    uniqueIndex('request_expert_relationship_unique_idx')
      .on(t.projectRequestId, t.expertProfileId)
      .where(sql`${t.deletedAt} IS NULL`),
    // Composite-FK targets (unique CONSTRAINTs, not just indexes) so proposals /
    // EOIs can pin their denormalised project_request_id / expert_profile_id to
    // THIS relationship's ids at the DB level. `id` is already unique, so these
    // composite uniques are trivially satisfied.
    unique('request_expert_relationship_id_request_uq').on(t.id, t.projectRequestId),
    unique('request_expert_relationship_id_expert_uq').on(t.id, t.expertProfileId),
    index('request_expert_relationship_request_idx').on(t.projectRequestId),
    index('request_expert_relationship_expert_idx').on(t.expertProfileId),
    index('request_expert_relationship_invited_by_idx').on(t.invitedByUserId),
    // "Active relationships at stage X" lists — partial on live rows.
    index('request_expert_relationship_status_idx')
      .on(t.projectRequestId, t.status)
      .where(sql`${t.deletedAt} IS NULL`),
  ]
);

/**
 * expressions_of_interest — an expert's pitch for a request. One live EOI per
 * relationship (unique on relationship_id). Denormalised request/expert ids for
 * direct request-scoped reads. All FKs CASCADE (the EOI is meaningless without
 * the relationship/request/expert).
 */
export const expressionsOfInterest = pgTable(
  'expressions_of_interest',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    relationshipId: uuid('relationship_id')
      .notNull()
      .references(() => requestExpertRelationships.id, { onDelete: 'cascade' }),
    projectRequestId: uuid('project_request_id')
      .notNull()
      .references(() => projectRequests.id, { onDelete: 'cascade' }),
    expertProfileId: uuid('expert_profile_id')
      .notNull()
      .references(() => expertProfiles.id, { onDelete: 'cascade' }),
    // Sanitised HTML pitch (rich text; same contract as request description).
    message: text('message').notNull(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).defaultNow().notNull(),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    // One LIVE EOI per relationship. PARTIAL on `deleted_at IS NULL` (mirrors
    // `request_expert_relationship_unique_idx` above) so a withdrawn
    // (soft-deleted) EOI frees the unique slot — `resubmit()` then inserts a
    // fresh live EOI cleanly, while a second LIVE EOI is still rejected.
    uniqueIndex('expression_of_interest_relationship_idx')
      .on(t.relationshipId)
      .where(sql`${t.deletedAt} IS NULL`),
    index('expression_of_interest_request_idx').on(t.projectRequestId),
    index('expression_of_interest_expert_idx').on(t.expertProfileId),
    // DB backstop (see proposals): the denormalised request/expert ids MUST equal
    // the relationship's own ids. The repo derives them from the locked
    // relationship; these composite FKs reject any divergent row from raw writes.
    foreignKey({
      columns: [t.relationshipId, t.projectRequestId],
      foreignColumns: [requestExpertRelationships.id, requestExpertRelationships.projectRequestId],
      name: 'eoi_rel_request_match_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.relationshipId, t.expertProfileId],
      foreignColumns: [requestExpertRelationships.id, requestExpertRelationships.expertProfileId],
      name: 'eoi_rel_expert_match_fk',
    }).onDelete('cascade'),
  ]
);

/**
 * proposals — the expert's project proposal (A6 / BAL-287). Money as integer
 * minor units (`price_cents`) + `currency` (ISO 4217 lowercase, matches Stripe
 * convention).
 *
 * VERSIONING: `relationship_id` is NON-unique — every version of a proposal for a
 * relationship is its own row carrying a monotonic `version` (≥1). Exactly one
 * LIVE row per relationship has `is_current = true`, enforced by the PARTIAL
 * unique index `proposal_current_per_relationship_idx` (`WHERE deleted_at IS NULL
 * AND is_current`). The repo's `resubmit` flips the current row's `is_current` to
 * false BEFORE inserting the new current — same transaction — so the unique slot
 * is vacated first and never collides. Superseded (`is_current=false`) and
 * soft-deleted versions are outside the index, so the full history coexists.
 *
 * PRICING: `pricing_method` shapes the rest. `fixed` → an agreed total
 * (`price_cents`) split into `proposal_payment_installments` (% rows); `tm` → a
 * deposit + rate + cadence (the nullable `deposit_cents`/`rate_cents`/`cadence`
 * columns) with `price_cents` as a non-binding estimate. Method↔fields coherence
 * (T&M needs deposit/rate, Fixed needs installments summing to 100) is enforced at
 * SUBMIT time in the repo/Zod, NOT by a DB CHECK — drafts are saved incomplete.
 *
 * All FKs CASCADE; the two composite backstop FKs pin the denormalised
 * request/expert ids to the relationship's own ids.
 */
export const proposals = pgTable(
  'proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    relationshipId: uuid('relationship_id')
      .notNull()
      .references(() => requestExpertRelationships.id, { onDelete: 'cascade' }),
    projectRequestId: uuid('project_request_id')
      .notNull()
      .references(() => projectRequests.id, { onDelete: 'cascade' }),
    expertProfileId: uuid('expert_profile_id')
      .notNull()
      .references(() => expertProfiles.id, { onDelete: 'cascade' }),
    // Default 'draft' (A6.2): the composer autosaves a draft proposal before
    // submit, so a freshly-inserted proposal starts as a `draft`. `createDraft()`
    // sets it explicitly; the default is belt-and-braces. (A6.1 had to keep this
    // at 'submitted' because the same migration that APPENDED the 'draft' enum
    // value couldn't also set it as the default — that constraint is now gone.)
    status: proposalStatusEnum('status').notNull().default('draft'),
    // First input — Fixed vs T&M. Default 'fixed' is backfill-safe; the repo
    // always sets it explicitly.
    pricingMethod: pricingMethodEnum('pricing_method').notNull().default('fixed'),
    // Monotonic per relationship; v2+ on resubmit.
    version: integer('version').notNull().default(1),
    // The current/superseded flag — exactly one live `is_current` per relationship
    // (partial unique index below).
    isCurrent: boolean('is_current').notNull().default(true),
    // Sanitised HTML main body (the design's "Overview"; renamed from `scope`).
    overview: text('overview').notNull(),
    // "Not included" — author-optional, sanitised text/HTML.
    exclusions: text('exclusions'),
    // "~N weeks" estimate — a DURATION, not a date. Author-optional.
    timeframeWeeks: integer('timeframe_weeks'),
    priceCents: integer('price_cents').notNull(),
    currency: text('currency').notNull().default('aud'),
    // ── T&M-only commercial terms (NULLABLE; only populated for `tm`) ──
    depositCents: integer('deposit_cents'),
    rateCents: integer('rate_cents'),
    cadence: proposalCadenceEnum('cadence'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).defaultNow().notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('proposal_relationship_idx').on(t.relationshipId),
    index('proposal_request_idx').on(t.projectRequestId),
    index('proposal_expert_idx').on(t.expertProfileId),
    // Versioning invariant — exactly one LIVE current proposal per relationship.
    // PARTIAL on `deleted_at IS NULL AND is_current` so superseded live versions
    // (`is_current=false`) and soft-deleted versions are unconstrained — the full
    // version history coexists. `relationship_id` stays non-unique (history).
    uniqueIndex('proposal_current_per_relationship_idx')
      .on(t.relationshipId)
      .where(sql`${t.deletedAt} IS NULL AND ${t.isCurrent}`),
    check('proposal_price_cents_nonneg', sql`${t.priceCents} >= 0`),
    check('proposal_version_positive', sql`${t.version} >= 1`),
    check(
      'proposal_deposit_cents_nonneg',
      sql`${t.depositCents} IS NULL OR ${t.depositCents} >= 0`
    ),
    check('proposal_rate_cents_nonneg', sql`${t.rateCents} IS NULL OR ${t.rateCents} >= 0`),
    check(
      'proposal_timeframe_positive',
      sql`${t.timeframeWeeks} IS NULL OR ${t.timeframeWeeks} >= 1`
    ),
    // DB backstop: the denormalised request/expert ids MUST equal the
    // relationship's own ids (the repo derives them from the locked relationship;
    // these composite FKs reject any divergent row from raw writes too).
    foreignKey({
      columns: [t.relationshipId, t.projectRequestId],
      foreignColumns: [requestExpertRelationships.id, requestExpertRelationships.projectRequestId],
      name: 'proposals_rel_request_match_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.relationshipId, t.expertProfileId],
      foreignColumns: [requestExpertRelationships.id, requestExpertRelationships.expertProfileId],
      name: 'proposals_rel_expert_match_fk',
    }).onDelete('cascade'),
  ]
);

/**
 * proposal_milestones — ordered deliverables for a proposal. Feeds future
 * milestone-activation invoicing (BAL-201). `sortOrder` is repo-assigned (next =
 * index) and best-effort — NO unique on `(proposalId, sortOrder)`: gaps/reorders
 * during composer editing make a unique sort constraint hostile (swapping two rows
 * transiently collides). Ties broken by `id`. `valueCents` is Fixed-only and
 * NULLABLE. `proposalId` CASCADE (milestones die with the proposal).
 */
export const proposalMilestones = pgTable(
  'proposal_milestones',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => proposals.id, { onDelete: 'cascade' }),
    sortOrder: integer('sort_order').notNull(),
    title: text('title').notNull(),
    descriptionHtml: text('description_html'),
    acceptanceCriteria: text('acceptance_criteria'),
    valueCents: integer('value_cents'),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('proposal_milestone_proposal_idx').on(t.proposalId),
    index('proposal_milestone_order_idx')
      .on(t.proposalId, t.sortOrder)
      .where(sql`${t.deletedAt} IS NULL`),
    check('proposal_milestone_value_nonneg', sql`${t.valueCents} IS NULL OR ${t.valueCents} >= 0`),
    check('proposal_milestone_sort_nonneg', sql`${t.sortOrder} >= 0`),
  ]
);

/**
 * proposal_payment_installments — Fixed-price % splits ("Upfront 30 / On delivery
 * 70"). A variable-length LIST of `% / label` rows (not columns — columns would
 * cap the count and fight the composer add/remove UX). `pct` is a WHOLE percent
 * (integer 0–100) — the house convention is integer minor units everywhere and
 * integer sum-to-100 is exact. The per-installment amount is DERIVED
 * (`round(priceCents * pct / 100)`) at read time, never stored. Sum-to-100 is a
 * SUBMIT-time repo/Zod rule (drafts are partial); the per-row 0–100 CHECK is the
 * only DB backstop. `proposalId` CASCADE.
 */
export const proposalPaymentInstallments = pgTable(
  'proposal_payment_installments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => proposals.id, { onDelete: 'cascade' }),
    sortOrder: integer('sort_order').notNull(),
    label: text('label').notNull(),
    pct: integer('pct').notNull(),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('proposal_installment_proposal_idx').on(t.proposalId),
    index('proposal_installment_order_idx')
      .on(t.proposalId, t.sortOrder)
      .where(sql`${t.deletedAt} IS NULL`),
    check('proposal_installment_pct_range', sql`${t.pct} >= 0 AND ${t.pct} <= 100`),
    check('proposal_installment_sort_nonneg', sql`${t.sortOrder} >= 0`),
  ]
);

/**
 * proposal_documents — the 3rd file scope (alongside request-brief attachments
 * and conversation files). Mirrors `conversation_files` (uploader attribution +
 * private presign-GET R2 model) plus a `kind` (`terms` supplement vs `ref` doc).
 * The storage util / download action are A6.2 — this models the table only.
 * `proposalId` CASCADE; `uploadedByUserId` RESTRICT (preserve attribution).
 *
 * `r2Key` unique is NON-partial — correct here (a fresh R2 key per upload is never
 * reused, so it is not a "reusable tuple" that the soft-delete partial-unique rule
 * targets), exactly as `conversation_file_key_idx` /
 * `project_request_document_key_idx`.
 */
export const proposalDocuments = pgTable(
  'proposal_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => proposals.id, { onDelete: 'cascade' }),
    uploadedByUserId: uuid('uploaded_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    kind: proposalDocumentKindEnum('kind').notNull(),
    r2Key: text('r2_key').notNull(),
    fileName: text('file_name').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    uniqueIndex('proposal_document_key_idx').on(t.r2Key),
    index('proposal_document_proposal_idx').on(t.proposalId),
    index('proposal_document_uploaded_by_idx').on(t.uploadedByUserId),
  ]
);

/**
 * proposal_change_requests — a client's structured request for revisions, raised
 * against a specific proposal version. `proposalVersion` is a SNAPSHOT int (the
 * version the change was raised against), NOT an FK to a specific proposal row, so
 * the change history reads correctly after the expert resubmits v2. `proposalId`
 * CASCADE; `requestedByUserId` RESTRICT (preserve authorship).
 */
export const proposalChangeRequests = pgTable(
  'proposal_change_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => proposals.id, { onDelete: 'cascade' }),
    requestedByUserId: uuid('requested_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    section: proposalChangeSectionEnum('section').notNull().default('general'),
    note: text('note').notNull(),
    proposalVersion: integer('proposal_version').notNull(),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('proposal_change_request_proposal_idx').on(t.proposalId),
    index('proposal_change_request_requested_by_idx').on(t.requestedByUserId),
    index('proposal_change_request_created_idx')
      .on(t.proposalId, t.createdAt)
      .where(sql`${t.deletedAt} IS NULL`),
    check('proposal_change_request_version_positive', sql`${t.proposalVersion} >= 1`),
  ]
);

/**
 * conversation_messages — the per-relationship thread (each expert ↔ client has
 * its own thread, not per request). `senderUserId` RESTRICT (preserve authorship;
 * sender is a client member, the expert's user, or an admin — role is derived at
 * read time, not baked into the row).
 */
export const conversationMessages = pgTable(
  'conversation_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    relationshipId: uuid('relationship_id')
      .notNull()
      .references(() => requestExpertRelationships.id, { onDelete: 'cascade' }),
    senderUserId: uuid('sender_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    // Sanitised HTML message body.
    body: text('body').notNull(),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('conversation_message_relationship_idx').on(t.relationshipId),
    index('conversation_message_sender_idx').on(t.senderUserId),
    // Chronological thread fetch — partial on live rows.
    index('conversation_message_thread_idx')
      .on(t.relationshipId, t.createdAt)
      .where(sql`${t.deletedAt} IS NULL`),
  ]
);

/**
 * conversation_files — files shared inside one expert's conversation (distinct
 * from the request-level brief attachments in project_request_documents). Same R2
 * column contract. `uploadedByUserId` RESTRICT (attribution).
 */
export const conversationFiles = pgTable(
  'conversation_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    relationshipId: uuid('relationship_id')
      .notNull()
      .references(() => requestExpertRelationships.id, { onDelete: 'cascade' }),
    uploadedByUserId: uuid('uploaded_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    r2Key: text('r2_key').notNull(),
    fileName: text('file_name').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    uniqueIndex('conversation_file_key_idx').on(t.r2Key),
    index('conversation_file_relationship_idx').on(t.relationshipId),
    index('conversation_file_uploaded_by_idx').on(t.uploadedByUserId),
  ]
);

/**
 * conversation_read_states — per-(relationship, user) read watermark (BAL-271).
 * One LIVE row per viewer per thread; `lastReadAt` only ever moves FORWARD
 * (repo upsert uses GREATEST). Unread is DERIVED at read time — newest live
 * inbound message/file `created_at` vs this watermark — never stored per
 * message. Both FKs CASCADE (a read state is meaningless without the thread
 * or the viewer).
 */
export const conversationReadStates = pgTable(
  'conversation_read_states',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    relationshipId: uuid('relationship_id')
      .notNull()
      .references(() => requestExpertRelationships.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    lastReadAt: timestamp('last_read_at', { withTimezone: true }).notNull(),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    // One LIVE read-state per (relationship, user). PARTIAL on `deleted_at IS
    // NULL` — hard-learned convention (mirrors the relationship/EOI unique
    // indexes above): soft-delete + a NON-partial unique index makes any
    // re-create silently fail, and the repo upsert's `targetWhere` arbiter
    // must match THIS predicate exactly.
    uniqueIndex('conversation_read_state_unique_idx')
      .on(t.relationshipId, t.userId)
      .where(sql`${t.deletedAt} IS NULL`),
    index('conversation_read_state_user_idx').on(t.userId),
    index('conversation_read_state_relationship_idx').on(t.relationshipId),
  ]
);

// ── Relations ──────────────────────────────────────────────────────────

export const requestExpertRelationshipsRelations = relations(
  requestExpertRelationships,
  ({ one, many }) => ({
    projectRequest: one(projectRequests, {
      fields: [requestExpertRelationships.projectRequestId],
      references: [projectRequests.id],
    }),
    expertProfile: one(expertProfiles, {
      fields: [requestExpertRelationships.expertProfileId],
      references: [expertProfiles.id],
    }),
    invitedBy: one(users, {
      fields: [requestExpertRelationships.invitedByUserId],
      references: [users.id],
    }),
    expressionsOfInterest: many(expressionsOfInterest),
    proposals: many(proposals),
    conversationMessages: many(conversationMessages),
    conversationFiles: many(conversationFiles),
    conversationReadStates: many(conversationReadStates),
  })
);

export const expressionsOfInterestRelations = relations(expressionsOfInterest, ({ one }) => ({
  relationship: one(requestExpertRelationships, {
    fields: [expressionsOfInterest.relationshipId],
    references: [requestExpertRelationships.id],
  }),
  projectRequest: one(projectRequests, {
    fields: [expressionsOfInterest.projectRequestId],
    references: [projectRequests.id],
  }),
  expertProfile: one(expertProfiles, {
    fields: [expressionsOfInterest.expertProfileId],
    references: [expertProfiles.id],
  }),
}));

export const proposalsRelations = relations(proposals, ({ one, many }) => ({
  relationship: one(requestExpertRelationships, {
    fields: [proposals.relationshipId],
    references: [requestExpertRelationships.id],
  }),
  projectRequest: one(projectRequests, {
    fields: [proposals.projectRequestId],
    references: [projectRequests.id],
  }),
  expertProfile: one(expertProfiles, {
    fields: [proposals.expertProfileId],
    references: [expertProfiles.id],
  }),
  milestones: many(proposalMilestones),
  paymentInstallments: many(proposalPaymentInstallments),
  documents: many(proposalDocuments),
  changeRequests: many(proposalChangeRequests),
}));

export const proposalMilestonesRelations = relations(proposalMilestones, ({ one }) => ({
  proposal: one(proposals, {
    fields: [proposalMilestones.proposalId],
    references: [proposals.id],
  }),
}));

export const proposalPaymentInstallmentsRelations = relations(
  proposalPaymentInstallments,
  ({ one }) => ({
    proposal: one(proposals, {
      fields: [proposalPaymentInstallments.proposalId],
      references: [proposals.id],
    }),
  })
);

export const proposalDocumentsRelations = relations(proposalDocuments, ({ one }) => ({
  proposal: one(proposals, {
    fields: [proposalDocuments.proposalId],
    references: [proposals.id],
  }),
  uploadedBy: one(users, {
    fields: [proposalDocuments.uploadedByUserId],
    references: [users.id],
  }),
}));

export const proposalChangeRequestsRelations = relations(proposalChangeRequests, ({ one }) => ({
  proposal: one(proposals, {
    fields: [proposalChangeRequests.proposalId],
    references: [proposals.id],
  }),
  requestedBy: one(users, {
    fields: [proposalChangeRequests.requestedByUserId],
    references: [users.id],
  }),
}));

export const conversationMessagesRelations = relations(conversationMessages, ({ one }) => ({
  relationship: one(requestExpertRelationships, {
    fields: [conversationMessages.relationshipId],
    references: [requestExpertRelationships.id],
  }),
  sender: one(users, {
    fields: [conversationMessages.senderUserId],
    references: [users.id],
  }),
}));

export const conversationFilesRelations = relations(conversationFiles, ({ one }) => ({
  relationship: one(requestExpertRelationships, {
    fields: [conversationFiles.relationshipId],
    references: [requestExpertRelationships.id],
  }),
  uploadedBy: one(users, {
    fields: [conversationFiles.uploadedByUserId],
    references: [users.id],
  }),
}));

export const conversationReadStatesRelations = relations(conversationReadStates, ({ one }) => ({
  relationship: one(requestExpertRelationships, {
    fields: [conversationReadStates.relationshipId],
    references: [requestExpertRelationships.id],
  }),
  user: one(users, {
    fields: [conversationReadStates.userId],
    references: [users.id],
  }),
}));

// ── Type exports ───────────────────────────────────────────────────────

export type RequestExpertRelationship = typeof requestExpertRelationships.$inferSelect;
export type NewRequestExpertRelationship = typeof requestExpertRelationships.$inferInsert;
export type ExpressionOfInterest = typeof expressionsOfInterest.$inferSelect;
export type NewExpressionOfInterest = typeof expressionsOfInterest.$inferInsert;
export type Proposal = typeof proposals.$inferSelect;
export type NewProposal = typeof proposals.$inferInsert;
export type ProposalMilestone = typeof proposalMilestones.$inferSelect;
export type NewProposalMilestone = typeof proposalMilestones.$inferInsert;
export type ProposalPaymentInstallment = typeof proposalPaymentInstallments.$inferSelect;
export type NewProposalPaymentInstallment = typeof proposalPaymentInstallments.$inferInsert;
export type ProposalDocument = typeof proposalDocuments.$inferSelect;
export type NewProposalDocument = typeof proposalDocuments.$inferInsert;
export type ProposalChangeRequest = typeof proposalChangeRequests.$inferSelect;
export type NewProposalChangeRequest = typeof proposalChangeRequests.$inferInsert;
export type ConversationMessage = typeof conversationMessages.$inferSelect;
export type NewConversationMessage = typeof conversationMessages.$inferInsert;
export type ConversationFile = typeof conversationFiles.$inferSelect;
export type NewConversationFile = typeof conversationFiles.$inferInsert;
export type ConversationReadState = typeof conversationReadStates.$inferSelect;
export type NewConversationReadState = typeof conversationReadStates.$inferInsert;
