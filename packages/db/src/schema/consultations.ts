import { pgTable, uuid, timestamp, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { expertProfiles } from './experts';
import { meetings } from './meetings';
import { consultationStatusEnum } from './enums';
import { timestamps, softDelete } from './helpers';

/**
 * `consultations` — THE AVAILABILITY READ MODEL OF THE MEETING LIFECYCLE (BAL-428
 * decision, Option C). The resolver subtracts these rows from an expert's open windows
 * (`consultations_expert_status_range_idx`).
 *
 * ⚠ BAL-498 — THIS TABLE NOW HAS A THIRD READER. `meetingsRepository.listCalendarForExpert`
 * (`repositories/meetings.ts`) joins through it as the ownership-resolving index for the
 * expert calendar page — `consultations.expert_profile_id` is the primary predicate that
 * proves a meeting is this expert's before any polymorphic `meeting_contexts.context_id`
 * lookup runs. The full reader list is therefore: the BAL-243 availability resolver, the
 * confirmed-consultation hero stat (`_shared/consultation-count.ts`), and the BAL-498
 * calendar read. All three are READS. The one-writer rule below is UNCHANGED by this —
 * BAL-498 adds a reader, never a writer.
 *
 * ⚠ THIS TABLE HAS EXACTLY ONE WRITER: `repositories/_shared/consultation-projection.ts`,
 * called ONLY from `meetingsRepository` and `meetingContextsRepository`, ALWAYS inside
 * their existing transactions. `consultationsRepository` is now READ-ONLY — its `create()`
 * was DELETED by BAL-428 precisely because a second writer is how the two tables drift.
 * Do not add one back, and do not raw-insert here outside a fixture.
 *
 * ⚠ CROSS-REFERENCE — `meetings` (schema/meetings.ts, BAL-418). BAL-418 shipped these as
 * TWO INDEPENDENT RECORDS of the same booked-slot fact, with a written ruling that BAL-129
 * must reconcile them. BAL-428 IS that reconciliation, and it chose Option C:
 *
 *   - `meeting_id` is NOT NULL. A consultation cannot exist without the meeting it
 *     projects, so "booked but invisible to availability" is now UNREPRESENTABLE — the
 *     silent double-booking BAL-418's docblock predicted is closed STRUCTURALLY, not by
 *     asking every future writer to remember two inserts.
 *   - The expert is resolved AT WRITE TIME, through the `meeting_contexts` seam
 *     (`case`/`project_kickoff`/`package_session`/`retainer_checkin` → `engagements`;
 *     `project_discovery` → `project_requests`). A booking that cannot name exactly one
 *     expert THROWS and rolls back. `admin` context rows are ignored, so an admin-only
 *     meeting projects NOTHING and blocks nobody's calendar.
 *   - Rejected Option A (teach every future status reader an extra predicate) and Option B
 *     (retire this stub and make the resolver read `meetings`) — B would put the whole
 *     meeting lifecycle inside the hot availability path.
 *
 * WHAT THIS DOES **NOT** CLOSE: two simultaneous bookings for the same window can still
 * both commit. There is no `btree_gist` / `tstzrange` EXCLUDE constraint here. BAL-428
 * closes the STALE-AVAILABILITY double-booking, NOT the RACE — that is a follow-up ticket.
 *
 * Status carries two values: `confirmed` (busy) and `cancelled` (frees the slot again).
 * The resolver only ever sees `confirmed` rows — the repository filter is the contract
 * boundary. `meetings.status='cancelled'` is what maps to `cancelled` here; every other
 * meeting status (including `ended`) maps to `confirmed`, so a delivered consultation
 * still counts toward the expert's hero stat.
 *
 * NO RLS, matching `meetings` / `meeting_contexts` / `credit_sessions` / `transcripts`:
 * access is gated at the application layer. This is a DEPARTURE from the drizzle-schema
 * skill's "never forget RLS" bullet, taken deliberately and consistently with every
 * sibling primitive — and this is not a new table.
 */
export const consultations = pgTable(
  'consultations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * THE MEETING THIS ROW PROJECTS. NOT NULL — see the docblock above; the whole point of
     * BAL-428 is that an unattached consultation cannot exist. ON DELETE cascade mirrors
     * `meeting_contexts.meeting_id`: a hard-deleted meeting takes its read model with it.
     * (Soft deletes go through `meetingsRepository.softDelete`, which stamps this row too.)
     */
    meetingId: uuid('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
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
    // UNCHANGED BY BAL-428 — the resolver read rides this exact index and this exact
    // column order. Do not reorder it to accommodate `meeting_id`.
    index('consultations_expert_status_range_idx').on(
      table.expertProfileId,
      table.status,
      table.startAt
    ),
    index('consultations_meeting_idx').on(table.meetingId),
    // ONE live projection row per meeting. PARTIAL on `deleted_at IS NULL` (memory
    // `reference_softdelete_nonpartial_unique_recreate`): a non-partial unique would let a
    // soft-deleted projection permanently block re-projecting that meeting, which is the
    // silent re-create failure that rule exists to stop.
    uniqueIndex('consultations_meeting_uq')
      .on(table.meetingId)
      .where(sql`${table.deletedAt} IS NULL`),
    check('consultations_start_before_end_check', sql`${table.startAt} < ${table.endAt}`),
    check('consultations_status_check', sql`${table.status} IN ('confirmed', 'cancelled')`),
  ]
);

export const consultationsRelations = relations(consultations, ({ one }) => ({
  expertProfile: one(expertProfiles, {
    fields: [consultations.expertProfileId],
    references: [expertProfiles.id],
  }),
  /**
   * The projected meeting. DELIBERATELY ONE-DIRECTIONAL: `meetingsRelations` gains NO
   * reverse `consultation` relation. A reverse relation would invite `with: { consultation:
   * true }` hydration on meeting reads and make the read model look like a first-class part
   * of the meeting aggregate, when it is a derived projection that only the availability
   * path and the reconciliation read may consult.
   */
  meeting: one(meetings, {
    fields: [consultations.meetingId],
    references: [meetings.id],
  }),
}));

export type Consultation = typeof consultations.$inferSelect;
export type NewConsultation = typeof consultations.$inferInsert;
/**
 * The two-value availability status, DERIVED FROM THE ENUM rather than restated.
 *
 * Mirrors `MeetingStatus` / `MeetingOutcome` in `schema/meetings.ts`. Every consumer that
 * used to spell `'confirmed' | 'cancelled'` inline — `consultationStatusForMeeting`, the
 * seeder's `NewConsultationSeed` — imports this instead, so adding a third label is a
 * compile error at each of them rather than a silently-narrower union.
 */
export type ConsultationStatus = (typeof consultationStatusEnum.enumValues)[number];
