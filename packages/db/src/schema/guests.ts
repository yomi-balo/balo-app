import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';
import { users } from './users';

export const meetingGuests = pgTable('meeting_guests', {
  id: uuid('id').primaryKey().defaultRandom(),
  meetingId: uuid('meeting_id').notNull(),

  userId: uuid('user_id').references(() => users.id),
  email: text('email').notNull(),
  name: text('name'),

  invitedById: uuid('invited_by_id').references(() => users.id).notNull(),
  accessToken: text('access_token').unique(),

  emailDomain: text('email_domain'),

  convertedToUserId: uuid('converted_to_user_id').references(() => users.id),
  convertedAt: timestamp('converted_at'),

  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export type MeetingGuest = typeof meetingGuests.$inferSelect;
