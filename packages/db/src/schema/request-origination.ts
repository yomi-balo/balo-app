import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
  unique,
  foreignKey,
  check,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { requestExpertRelationshipStatusEnum, proposalStatusEnum } from './enums';
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
 * Rich text authored by users (`message`, `scope`, `body`) is server-sanitised
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
 * proposals — the expert's scoped proposal. Money as integer minor units
 * (`price_cents`) + `currency` (ISO 4217 lowercase, matches Stripe convention).
 * NON-unique on relationship_id (A5/A6 may resubmit/revise; enforce "exactly one"
 * in the caller if product wants it). All FKs CASCADE.
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
    status: proposalStatusEnum('status').notNull().default('submitted'),
    // Sanitised HTML scope / SOW summary.
    scope: text('scope').notNull(),
    priceCents: integer('price_cents').notNull(),
    currency: text('currency').notNull().default('aud'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).defaultNow().notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('proposal_relationship_idx').on(t.relationshipId),
    index('proposal_request_idx').on(t.projectRequestId),
    index('proposal_expert_idx').on(t.expertProfileId),
    check('proposal_price_cents_nonneg', sql`${t.priceCents} >= 0`),
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

export const proposalsRelations = relations(proposals, ({ one }) => ({
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
export type ConversationMessage = typeof conversationMessages.$inferSelect;
export type NewConversationMessage = typeof conversationMessages.$inferInsert;
export type ConversationFile = typeof conversationFiles.$inferSelect;
export type NewConversationFile = typeof conversationFiles.$inferInsert;
export type ConversationReadState = typeof conversationReadStates.$inferSelect;
export type NewConversationReadState = typeof conversationReadStates.$inferInsert;
