import { pgTable, uuid, timestamp, index, check } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { expertProfiles } from './experts';
import { consultationStatusEnum } from './enums';
import { timestamps, softDelete } from './helpers';

/**
 * Minimum consultation stub for the availability resolver to subtract booked
 * time from open windows. All real domain fields (client, pricing, engagement
 * model, payment, messaging) are intentionally omitted — they land with the
 * consultations feature work.
 *
 * Status carries two values: `confirmed` (busy) and `cancelled` (frees the
 * slot again). The resolver only ever sees `confirmed` rows — the repository
 * filter is the contract boundary.
 */
export const consultations = pgTable(
  'consultations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    expertProfileId: uuid('expert_profile_id')
      .notNull()
      .references(() => expertProfiles.id, { onDelete: 'cascade' }),
    startAt: timestamp('start_at', { withTimezone: true }).notNull(),
    endAt: timestamp('end_at', { withTimezone: true }).notNull(),
    status: consultationStatusEnum('status').notNull().default('confirmed'),
    ...timestamps,
    ...softDelete,
  },
  (table) => ({
    expertProfileIdx: index('consultations_expert_profile_idx').on(table.expertProfileId),
    expertStatusRangeIdx: index('consultations_expert_status_range_idx').on(
      table.expertProfileId,
      table.status,
      table.startAt
    ),
    startBeforeEndCheck: check(
      'consultations_start_before_end_check',
      sql`${table.startAt} < ${table.endAt}`
    ),
    // Explicit status check in addition to the enum so the cancelled-then-free
    // edge case has a clear assertion surface in the integration test.
    statusCheck: check(
      'consultations_status_check',
      sql`${table.status} IN ('confirmed', 'cancelled')`
    ),
  })
);

export const consultationsRelations = relations(consultations, ({ one }) => ({
  expertProfile: one(expertProfiles, {
    fields: [consultations.expertProfileId],
    references: [expertProfiles.id],
  }),
}));

export type Consultation = typeof consultations.$inferSelect;
export type NewConsultation = typeof consultations.$inferInsert;
