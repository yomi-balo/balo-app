import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { meetings } from './meetings';
import { users } from './users';

/**
 * meeting_guests — an invited, not-yet-registered attendee of a meeting.
 *
 * BAL-418 flipped `meeting_id` from a dangling NOT-NULL no-FK uuid to a REAL FK
 * (ON DELETE cascade) now that `meetings` exists. That is the ONLY change this ticket
 * makes to the table, and the scope limit is deliberate:
 *
 * ⚠ ASSIGNED TO BAL-408 — this table does NOT follow the house `...timestamps` /
 * `...softDelete` convention, and BAL-418 does not fix that. Adding `deleted_at` under the
 * existing NON-PARTIAL `access_token` UNIQUE below instantiates the documented
 * `reference_softdelete_nonpartial_unique_recreate` hazard: a soft-deleted guest would
 * permanently occupy its token and could never be re-invited. Fixing it means making that
 * index PARTIAL on `deleted_at IS NULL` and auditing every guest read — that is BAL-408's
 * work (it owns the guest participation model), and this note is the written assignment.
 */
export const meetingGuests = pgTable(
  'meeting_guests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // BAL-418: real FK. CASCADE — a guest invitation dies with its meeting.
    meetingId: uuid('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),

    userId: uuid('user_id').references(() => users.id),
    email: text('email').notNull(),
    name: text('name'),

    invitedById: uuid('invited_by_id')
      .references(() => users.id)
      .notNull(),
    // ⚠ NON-PARTIAL unique — see the BAL-408 assignment in the docblock above before
    // adding `deleted_at` to this table.
    accessToken: text('access_token').unique(),

    emailDomain: text('email_domain'),

    convertedToUserId: uuid('converted_to_user_id').references(() => users.id),
    convertedAt: timestamp('converted_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('meeting_guest_meeting_idx').on(t.meetingId)]
);

export type MeetingGuest = typeof meetingGuests.$inferSelect;
