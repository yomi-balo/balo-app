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
 *
 * ⚠ CROSS-REFERENCE — `meetings` (schema/meetings.ts, BAL-418). That table stores the
 * SAME booked-slot fact a second time (`scheduled_start`/`scheduled_end`). BAL-418 ships
 * NO writer that creates a meeting from a booking, so there is no regression today. The
 * regression appears the moment BAL-129 lands: a booked meeting would NOT block the
 * expert's availability, because THIS resolver reads `consultations` only — a silent
 * double-booking bug. RULING for BAL-129 — it must either (a) write the `consultations`
 * row and the `meetings` row in ONE transaction, or (b) migrate the availability resolver
 * to read `meetings` and retire this stub. It must not ship a meeting-creating path that
 * does neither. Reschedule/cancel (BAL-409/BAL-410) must move BOTH rows.
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
  // Explicit status check in addition to the enum so the cancelled-then-free
  // edge case has a clear assertion surface in the integration test.
  (table) => [
    index('consultations_expert_profile_idx').on(table.expertProfileId),
    index('consultations_expert_status_range_idx').on(
      table.expertProfileId,
      table.status,
      table.startAt
    ),
    check('consultations_start_before_end_check', sql`${table.startAt} < ${table.endAt}`),
    check('consultations_status_check', sql`${table.status} IN ('confirmed', 'cancelled')`),
  ]
);

export const consultationsRelations = relations(consultations, ({ one }) => ({
  expertProfile: one(expertProfiles, {
    fields: [consultations.expertProfileId],
    references: [expertProfiles.id],
  }),
}));

export type Consultation = typeof consultations.$inferSelect;
export type NewConsultation = typeof consultations.$inferInsert;
