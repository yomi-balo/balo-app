import { pgTable, uuid, integer, time, index, check } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { expertProfiles } from './experts';
import { timestamps, softDelete } from './helpers';

/**
 * Recurring weekly availability windows owned by an expert.
 *
 * Times are stored as wall-clock values in the expert's own timezone
 * (`expert_profiles.timezone`) — never as UTC instants. The resolver
 * expands these per-date into UTC for DST correctness.
 *
 * Soft-deletable. The schedule editor (BAL-195) owns mutations; BAL-243
 * only reads.
 */
export const availabilityRules = pgTable(
  'availability_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    expertProfileId: uuid('expert_profile_id')
      .notNull()
      .references(() => expertProfiles.id, { onDelete: 'cascade' }),
    // 0 = Sunday, 6 = Saturday (matches JS Date#getDay)
    dayOfWeek: integer('day_of_week').notNull(),
    // Local wall-clock time in the expert's timezone (Postgres `time`).
    startTime: time('start_time').notNull(),
    endTime: time('end_time').notNull(),
    ...timestamps,
    ...softDelete,
  },
  (table) => ({
    expertProfileIdx: index('avail_rules_expert_profile_idx').on(table.expertProfileId),
    expertDayIdx: index('avail_rules_expert_day_idx').on(table.expertProfileId, table.dayOfWeek),
    dayCheck: check('avail_rules_day_check', sql`${table.dayOfWeek} BETWEEN 0 AND 6`),
    startBeforeEndCheck: check(
      'avail_rules_start_before_end_check',
      sql`${table.startTime} < ${table.endTime}`
    ),
    // Note: no unique constraint on (expert, day, start) — overlapping rules are
    // allowed in v1; the resolver merges windows. BAL-195's schedule editor may
    // tighten this later if needed.
  })
);

export const availabilityRulesRelations = relations(availabilityRules, ({ one }) => ({
  expertProfile: one(expertProfiles, {
    fields: [availabilityRules.expertProfileId],
    references: [expertProfiles.id],
  }),
}));

export type AvailabilityRule = typeof availabilityRules.$inferSelect;
export type NewAvailabilityRule = typeof availabilityRules.$inferInsert;
