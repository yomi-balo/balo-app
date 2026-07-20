import { pgTable, uuid, text, timestamp, index, check } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { actionItemStatusEnum, actionItemSourceEnum, actionItemAssigneePartyEnum } from './enums';
import { engagements } from './engagements';
import { users } from './users';
import { timestamps, softDelete } from './helpers';

/**
 * action_items — a first-class, engagement-owned to-do produced from a meeting (ADR-1043,
 * BAL-391). Engagement-generic: the ONLY hard context is the engagement (party + capability
 * scope). `meeting_id` is a NULLABLE, NO-FK forward seam for the meetings primitive (BAL-387,
 * unbuilt) — do NOT conflate with meeting_guests.meeting_id. `body` is PLAIN TEXT (the item
 * line) — no HTML, no sanitisation needed; render as text (React escapes). Person-attribution
 * FKs are ON DELETE restrict ("preserve attribution", the engagement_milestones pattern);
 * created_by is nullable so the ai_extracted pipeline (no user actor) can insert.
 */
export const actionItems = pgTable(
  'action_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Owning context + capability scope. CASCADE (items die with the engagement).
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id, { onDelete: 'cascade' }),

    // Forward seam (BAL-387 / meetings primitive). NULLABLE, NO FK — the table does not exist yet.
    meetingId: uuid('meeting_id'),

    body: text('body').notNull(), // the action-item text (ticket's `text` field); plain text.
    status: actionItemStatusEnum('status').notNull().default('open'),
    source: actionItemSourceEnum('source').notNull(),
    assigneeParty: actionItemAssigneePartyEnum('assignee_party'), // null = unassigned
    dueAt: timestamp('due_at', { withTimezone: true }), // optional; reminder sweep DEFERRED

    // ── Retrospective person attribution (restrict = preserve attribution) ──
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }), // null on the ai_extracted path
    assignedByUserId: uuid('assigned_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    assignedAt: timestamp('assigned_at', { withTimezone: true }),
    completedByUserId: uuid('completed_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    completedAt: timestamp('completed_at', { withTimezone: true }),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('action_item_engagement_idx').on(t.engagementId),
    // Open/done counts per engagement — partial on LIVE rows. Predicate references ONLY
    // deleted_at (never an enum literal) — the house convention (safe against the ADD-VALUE hazard).
    index('action_item_engagement_status_idx')
      .on(t.engagementId, t.status)
      .where(sql`${t.deletedAt} IS NULL`),
    // Forward seam read (BAL-388 recap lists by meeting). Partial on non-null meeting + live.
    index('action_item_meeting_idx')
      .on(t.meetingId)
      .where(sql`${t.meetingId} IS NOT NULL AND ${t.deletedAt} IS NULL`),
    check('action_item_body_nonempty', sql`length(btrim(${t.body})) > 0`),
  ]
);

// ── Relations ──────────────────────────────────────────────────────────

export const actionItemsRelations = relations(actionItems, ({ one }) => ({
  engagement: one(engagements, {
    fields: [actionItems.engagementId],
    references: [engagements.id],
  }),
  createdBy: one(users, { fields: [actionItems.createdByUserId], references: [users.id] }),
  assignedBy: one(users, { fields: [actionItems.assignedByUserId], references: [users.id] }),
  completedBy: one(users, { fields: [actionItems.completedByUserId], references: [users.id] }),
}));

// ── Type exports ───────────────────────────────────────────────────────

export type ActionItem = typeof actionItems.$inferSelect;
export type NewActionItem = typeof actionItems.$inferInsert;
