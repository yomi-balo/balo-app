import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { conversationContextTypeEnum } from './enums';
import { users } from './users';
import { meetings } from './meetings';
import { timestamps, softDelete } from './helpers';

/**
 * The conversation primitive (BAL-424 / ADR-1045 §2).
 *
 * The three messaging tables below (`conversation_messages`, `conversation_files`,
 * `conversation_read_states`) MOVED here from `request-origination.ts`, where they shipped
 * in BAL-271 anchored on `request_expert_relationships.id`. That file is named for request
 * origination, which is exactly why a directory scan missed messaging and why BAL-424 was
 * originally filed as "messaging has no schema". After the re-anchor they are not
 * request-origination tables at all — they hang off `conversations`, which hangs off the
 * polymorphic `conversation_contexts` seam and therefore serves a Case (no relationship row
 * exists anywhere) exactly as well as a project request.
 *
 * Rich text authored by users (`body`) is server-sanitised HTML — the same contract as
 * `project_requests.description`; sanitisation happens in the web caller, never in
 * `@balo/db`.
 */

/**
 * conversations (BAL-424 / ADR-1045 §2) — the thread IDENTITY, and nothing else. It carries
 * NO context column for the same reason `meetings` carries none: `conversation_contexts` is
 * the ONLY place that answers "whose thread is this".
 *
 * Deliberately column-free beyond the house four. A title, a status or a "last message at"
 * cache would each be a second source of truth for something already derivable
 * (`listThreadSummaries` derives recency; the anchor row carries the title; writability is
 * derived from the anchor's lifecycle — see `engagementConversationIsWritable`).
 *
 * NO RLS (matching `meetings`, `meeting_contexts`, and the credit/transcript precedents):
 * Balo auths with WorkOS + iron-session, `auth.uid()` is meaningless, and the boundary is
 * the application layer (ADR-1029).
 */
export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  ...timestamps,
  ...softDelete,
});

/**
 * conversation_contexts (BAL-424 / ADR-1045 §2) — THE POLYMORPHIC SEAM, structurally
 * parallel to `meeting_contexts` (whose docblock names this table by ticket number and says
 * "copy this shape, do not invent a second one"). Three deliberate deviations are recorded
 * below; everything else is the same shape.
 *
 * ⚠⚠ TENANCY OBLIGATION — INHERITED VERBATIM FROM `meeting_contexts`, AND STRICTLY WORSE
 * HERE. `context_id` has NO FOREIGN KEY (it is polymorphic — `engagements.id` OR
 * `request_expert_relationships.id`) and NO RLS behind it, so a uuid belonging to ANOTHER
 * TENANT does not raise `23503`: it SUCCEEDS SILENTLY. For meetings the consequence was
 * join credentials and calendar DoS. For conversations it is DIRECT MESSAGE DISCLOSURE —
 * `listMessages(conversationId, …)` hands back another company's private thread verbatim,
 * and `postMessage` writes into it.
 *
 * THEREFORE: every caller that turns a `(contextType, contextId)` pair into a
 * `conversationId` MUST first resolve the context's OWNING PARTY and check a capability
 * against it. That check belongs in the service / server-action layer, NOT here —
 * authorization is capability-based and resolved at the call site (ADR-1029), and a gate
 * inside a repository would be the deviation.
 *
 * ✅ THE WORKING PRECEDENTS TO COPY, IN ORDER OF CLOSENESS:
 *   · `apps/api/src/services/meetings/authorize-meeting-booking.ts` (BAL-129) — resolve the
 *     owning party per label, run the MEMBERSHIP CHECK BEFORE ANY COHERENCE OR STATE CHECK
 *     so the gate is not a cross-tenant existence oracle, and collapse "no such row" and
 *     "not yours" into ONE 404 literal.
 *   · `apps/api/src/services/meetings/authorize-meeting-participation.ts` (BAL-408) — the
 *     TWO-SIDED version (client = membership axis; expert = the shipped VISIBILITY rule),
 *     which is the shape a conversation needs because both parties read and write.
 * `apps/web/src/lib/conversations/authorize-conversation-context.ts` is that obligation
 * discharged for the `engagement` arm; the `relationship` arm keeps its shipped gate
 * (`apps/web/src/lib/project-request/resolve-conversation-access.ts`).
 *
 * ⚠⚠ LIFECYCLE OBLIGATION — THE SIBLING OF THE TENANCY ONE, AND IT ARISES FROM THE SAME
 * MISSING FK. `context_id` points at nothing the database enforces, so DELETING THE ANCHOR
 * DELETES NOTHING HERE. Before BAL-424 the three messaging tables FK'd
 * `request_expert_relationships` → `project_requests` → `companies`, so a hard company delete
 * swept the whole thread for free. Migration 0062 removed that chain and did not replace it:
 * hard-deleting an engagement, a relationship or a request now leaves its conversation, its
 * messages and its files LIVE AND UNREACHABLE.
 *
 * That is not only orphan rows. `conversation_messages.sender_user_id` and
 * `conversation_files.uploaded_by_user_id` are `ON DELETE RESTRICT` (authorship is preserved
 * deliberately), so a subsequent `DELETE FROM users` RAISES `23503` where the old cascade had
 * already cleared the children — a hard delete that used to succeed now fails.
 *
 * THEREFORE: any hard-delete path that removes an anchor or an author MUST sweep this subtree
 * itself, and the only reliable key is AUTHORSHIP (the anchor may already have been cascaded
 * away, leaving a conversation pointing at nothing). Deleting the `conversations` parent
 * cascades contexts, messages, files and read states in one step.
 *
 * ✅ THE DISCHARGE, AND THE PATTERN TO COPY: `deleteSeedConversations` in
 * `apps/api/src/services/seed/truncate.ts` — the only hard-delete path on the platform today.
 * SOFT deletes are unaffected: soft-deleting a relationship deliberately leaves its
 * conversation live (history is preserved; the read path gates on `isThreadOpenStatus`).
 */
export const conversationContexts = pgTable(
  'conversation_contexts',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),

    contextType: conversationContextTypeEnum('context_type').notNull(),

    /**
     * POLYMORPHIC — NO FK BY DESIGN. Targets `request_expert_relationships.id` or
     * `engagements.id` per `context_type`.
     *
     * ⚠ NOT NULL — DEVIATION 1 FROM `meeting_contexts`, whose `context_id` is nullable and
     * governed by the biconditional CHECK `(context_id IS NULL) = (context_type='admin')`.
     * With no `admin` label there is no NULL case, so this seam inherits NEITHER the
     * nullable column, NOR that CHECK, NOR the `meeting_context_admin_uq` partial unique
     * that exists only because Postgres treats NULLs as distinct. `NOT NULL` is strictly
     * stronger and removes three moving parts. See `conversation_context_type`'s docblock
     * for why `admin` was dropped.
     */
    contextId: uuid('context_id').notNull(),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    /**
     * ⚠ DEVIATION 2 — 1:1 PER CONTEXT (scope decision 4). `meeting_contexts` is unique on
     * the TRIPLE `(meeting_id, context_type, context_id)` and carries a PLAIN reverse index
     * on `(context_type, context_id)`, deliberately permitting 1:N (many meetings per
     * context). This index is unique on the SUBJECT alone: ONE live thread per
     * relationship, ONE per engagement. That is the whole product: a conversation is a
     * continuous thread, and "two threads for one case" is the state the seam exists to
     * make unrepresentable. DO NOT "fix" this back to the triple.
     *
     * It is also strictly stronger than the triple would be — at most one row per subject
     * globally implies at most one per conversation — so no second unique is needed.
     *
     * PARTIAL on `deleted_at IS NULL` — memory
     * `reference_softdelete_nonpartial_unique_recreate`: soft-delete plus a NON-partial
     * unique makes any re-create silently fail. Any `onConflictDoNothing` arbiter against
     * it MUST restate this predicate exactly or Postgres answers `42P10`.
     */
    uniqueIndex('conversation_context_subject_idx')
      .on(t.contextType, t.contextId)
      .where(sql`${t.deletedAt} IS NULL`),

    /**
     * ⚠ DEVIATION 3 — THERE IS NO UNIQUE ON `conversation_id` ALONE, AND THAT IS LOAD
     * BEARING. Kickoff carry-over gives ONE conversation TWO live context rows
     * (`relationship` + `engagement`), so the pre-sales thread continues into delivery. The
     * relationship context is NOT removed at kickoff — it stays, so the thread is still
     * reachable from the request-origination side and reads correctly from either end.
     *
     * PARTIAL on `deleted_at IS NULL` — this one serves the LIVE-ROW reads (`listContexts`,
     * the guest scope resolver), which all filter soft-deleted rows.
     */
    index('conversation_context_conversation_idx')
      .on(t.conversationId)
      .where(sql`${t.deletedAt} IS NULL`),

    /**
     * ⚠⚠ THE FK'S INDEX, AND IT MUST BE NON-PARTIAL. `conversation_id` REFERENCES
     * `conversations(id) ON DELETE CASCADE`, and Postgres executes that cascade with an
     * unqualified `DELETE FROM conversation_contexts WHERE conversation_id = $1` — it does
     * NOT add `deleted_at IS NULL`, because the cascade must remove soft-deleted children
     * too. A PARTIAL index cannot serve a predicate it does not cover, so with only the
     * partial index above the cascade SEQ-SCANS the whole table on every conversation
     * delete. (Reproduced against a real Postgres 16 container, not inferred.)
     *
     * Kept as a SEPARATE index rather than by widening the partial one: the live-row reads
     * are the hot path and benefit from the smaller, denser partial index, while this one
     * exists solely so referential integrity stays O(log n). Two small indexes on a
     * low-cardinality table is the cheaper trade.
     */
    index('conversation_context_conversation_fk_idx').on(t.conversationId),
  ]
);

/**
 * conversation_messages — the thread's messages. Was per-RELATIONSHIP (BAL-271); BAL-424
 * re-anchors it to `conversations`. `senderUserId` RESTRICT (preserve authorship; sender is
 * a client member, the expert's user, or an admin — ROLE IS DERIVED AT READ TIME, NOT BAKED
 * INTO THE ROW). ⚠ THERE IS NO `party` COLUMN AND ONE MUST NOT BE ADDED: it would go stale
 * the moment membership changes.
 */
export const conversationMessages = pgTable(
  'conversation_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    senderUserId: uuid('sender_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    /**
     * BAL-418 meeting seam. Set when the message was sent from the in-call panel; NULL for
     * every message sent between calls.
     *
     * ON DELETE SET NULL, matching `action_items.meeting_id`: deleting a meeting must not
     * delete what the parties said. ⚠ AND IT IS THE FAIL-CLOSED DIRECTION FOR THE GUEST
     * FILTER — a meeting-level guest sees ONLY rows whose `sent_during_meeting_id` equals
     * their own meeting, so nulling the column REMOVES visibility rather than granting it.
     * RESTRICT was rejected: it would block meeting deletion on a chat message.
     */
    sentDuringMeetingId: uuid('sent_during_meeting_id').references(() => meetings.id, {
      onDelete: 'set null',
    }),

    // Sanitised HTML message body.
    body: text('body').notNull(),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('conversation_message_conversation_idx').on(t.conversationId),
    index('conversation_message_sender_idx').on(t.senderUserId),
    // Chronological thread fetch — partial on live rows. Also the keyset page's index.
    index('conversation_message_thread_idx')
      .on(t.conversationId, t.createdAt)
      .where(sql`${t.deletedAt} IS NULL`),
    /**
     * THE GUEST FILTER'S INDEX + BAL-388's "what was said during this call". Partial on
     * NOT NULL + live, mirroring `action_item_meeting_idx` / `credit_sessions_meeting_idx`.
     * Predicates on COLUMNS only — never an enum literal (house rule).
     */
    index('conversation_message_meeting_idx')
      .on(t.sentDuringMeetingId, t.createdAt)
      .where(sql`${t.sentDuringMeetingId} IS NOT NULL AND ${t.deletedAt} IS NULL`),
  ]
);

/**
 * conversation_files — files shared inside one conversation. ⚠ CONVERSATION-SCOPED, NOT
 * MEETING-SCOPED, and it cannot key to `meetings.id`: a file shared between calls belongs to
 * no meeting. BAL-423's `meeting_files` is the fourth file scope and the two merge on READ in
 * the case surface (BAL-421). `uploadedByUserId` RESTRICT (attribution). `r2Key` unique is
 * NON-partial, deliberately — a fresh R2 key per upload is never reused, so it is not the
 * "reusable tuple" the soft-delete partial-unique rule targets (same ruling as
 * `proposal_document_key_idx` / `project_request_document_key_idx`).
 */
export const conversationFiles = pgTable(
  'conversation_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
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
    index('conversation_file_conversation_idx').on(t.conversationId),
    index('conversation_file_uploaded_by_idx').on(t.uploadedByUserId),
  ]
);

/**
 * conversation_read_states — per-(conversation, user) read watermark (BAL-271). ⚠ EVERY
 * SHIPPED SEMANTIC IS PRESERVED: one LIVE row per viewer per thread; `lastReadAt` only ever
 * moves FORWARD (repo upsert uses GREATEST); unread is DERIVED at read time — newest live
 * inbound message/file `created_at` vs this watermark — NEVER stored per message. Both FKs
 * CASCADE (a read state is meaningless without the thread or the viewer), unlike the RESTRICT
 * on message/file authorship — deliberate, and unchanged.
 */
export const conversationReadStates = pgTable(
  'conversation_read_states',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    lastReadAt: timestamp('last_read_at', { withTimezone: true }).notNull(),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    // PARTIAL on `deleted_at IS NULL`. The repo upsert's `targetWhere` arbiter MUST restate
    // this predicate EXACTLY or the second mark throws a raw 23505 / 42P10.
    uniqueIndex('conversation_read_state_unique_idx')
      .on(t.conversationId, t.userId)
      .where(sql`${t.deletedAt} IS NULL`),
    index('conversation_read_state_user_idx').on(t.userId),
    index('conversation_read_state_conversation_idx').on(t.conversationId),
  ]
);

// ── Relations ──────────────────────────────────────────────────────────

export const conversationsRelations = relations(conversations, ({ many }) => ({
  contexts: many(conversationContexts),
  messages: many(conversationMessages),
  files: many(conversationFiles),
  readStates: many(conversationReadStates),
}));

export const conversationContextsRelations = relations(conversationContexts, ({ one }) => ({
  conversation: one(conversations, {
    fields: [conversationContexts.conversationId],
    references: [conversations.id],
  }),
  // NO relation to the subject — `context_id` is polymorphic and has no FK.
}));

export const conversationMessagesRelations = relations(conversationMessages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [conversationMessages.conversationId],
    references: [conversations.id],
  }),
  sender: one(users, {
    fields: [conversationMessages.senderUserId],
    references: [users.id],
  }),
  sentDuringMeeting: one(meetings, {
    fields: [conversationMessages.sentDuringMeetingId],
    references: [meetings.id],
  }),
}));

export const conversationFilesRelations = relations(conversationFiles, ({ one }) => ({
  conversation: one(conversations, {
    fields: [conversationFiles.conversationId],
    references: [conversations.id],
  }),
  uploadedBy: one(users, {
    fields: [conversationFiles.uploadedByUserId],
    references: [users.id],
  }),
}));

export const conversationReadStatesRelations = relations(conversationReadStates, ({ one }) => ({
  conversation: one(conversations, {
    fields: [conversationReadStates.conversationId],
    references: [conversations.id],
  }),
  user: one(users, {
    fields: [conversationReadStates.userId],
    references: [users.id],
  }),
}));

// ── Type exports ───────────────────────────────────────────────────────

export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
export type ConversationContext = typeof conversationContexts.$inferSelect;
export type NewConversationContext = typeof conversationContexts.$inferInsert;
export type ConversationMessage = typeof conversationMessages.$inferSelect;
export type NewConversationMessage = typeof conversationMessages.$inferInsert;
export type ConversationFile = typeof conversationFiles.$inferSelect;
export type NewConversationFile = typeof conversationFiles.$inferInsert;
export type ConversationReadState = typeof conversationReadStates.$inferSelect;
export type NewConversationReadState = typeof conversationReadStates.$inferInsert;

/** What a conversation is anchored to (schema-derived — single source of truth). */
export type ConversationContextType = (typeof conversationContextTypeEnum.enumValues)[number];
