import { pgTable, uuid, integer, text, date, index, check } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { engagements } from './engagements';
import { engagementMilestones } from './engagement-milestones';
import { users } from './users';
import { timestamps, softDelete } from './helpers';

/**
 * engagement_time_entries — time an expert logs against a milestone of a time-and-materials
 * project: a UTC work date, whole minutes and a required note the client sees.
 *
 * FK TARGET IS THE SUPERTYPE (`engagements.id`) with CASCADE, so a later retainer engagement
 * can log time here too. Entries are PROJECT-only and T&M-only by writer, not by constraint:
 * every writer locks the active project first and checks its pricing method.
 *
 * `engagement_milestone_id` CASCADES: milestones are only ever soft-deleted, and a hard delete
 * reaches them only through the engagement cascade, which RESTRICT here would break. An entry
 * on a soft-deleted milestone stays live and still counts toward the engagement's totals.
 *
 * `user_id` is the author (RESTRICT preserves attribution). It is DELIBERATELY UNINDEXED, the
 * same ruling as the actor FKs on `engagement_change_orders`: reads filter by engagement or
 * milestone and hydrate the author over the `users` PK, and users are never hard-deleted, so
 * the RESTRICT FK's delete-time scan never runs.
 *
 * NO RLS — A KNOWING DEVIATION, RECORDED. No schema file in this package calls
 * `.enableRLS()` or `pgPolicy()`: Balo authenticates with WorkOS + iron-session, so a
 * Supabase-shaped policy would be decoration; every reader is the admin `db` client and
 * the boundary is the application layer (the engagement axis for the expert's writes,
 * membership for the client's reads). ⚠ This deviates from the `drizzle-schema` skill
 * ("Forgetting RLS on new tables") and is flagged in the PR body, as
 * `engagement-change-orders.ts` does.
 */
export const engagementTimeEntries = pgTable(
  'engagement_time_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Parent engagement — CASCADE (entries die with the engagement).
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id, { onDelete: 'cascade' }),

    engagementMilestoneId: uuid('engagement_milestone_id')
      .notNull()
      .references(() => engagementMilestones.id, { onDelete: 'cascade' }),

    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    /** The UTC calendar day the work was done, as 'YYYY-MM-DD'. */
    workedOn: date('worked_on', { mode: 'string' }).notNull(),

    minutes: integer('minutes').notNull(),

    /** What the time went on. Shown to the client beside every entry. */
    note: text('note').notNull(),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    // A milestone's live logged total (crossing detection, the hours bar).
    index('engagement_time_entry_milestone_idx')
      .on(t.engagementMilestoneId)
      .where(sql`${t.deletedAt} IS NULL`),
    // The engagement's time log and its billing-period window.
    index('engagement_time_entry_engagement_worked_idx')
      .on(t.engagementId, t.workedOn)
      .where(sql`${t.deletedAt} IS NULL`),
    check('engagement_time_entry_minutes_positive', sql`${t.minutes} > 0`),
    check('engagement_time_entry_note_present', sql`length(btrim(${t.note})) > 0`),
  ]
);

// ── Relations ──────────────────────────────────────────────────────────

export const engagementTimeEntriesRelations = relations(engagementTimeEntries, ({ one }) => ({
  engagement: one(engagements, {
    fields: [engagementTimeEntries.engagementId],
    references: [engagements.id],
  }),
  milestone: one(engagementMilestones, {
    fields: [engagementTimeEntries.engagementMilestoneId],
    references: [engagementMilestones.id],
  }),
  user: one(users, {
    fields: [engagementTimeEntries.userId],
    references: [users.id],
  }),
}));

// ── Type exports ───────────────────────────────────────────────────────

export type EngagementTimeEntry = typeof engagementTimeEntries.$inferSelect;
export type NewEngagementTimeEntry = typeof engagementTimeEntries.$inferInsert;
