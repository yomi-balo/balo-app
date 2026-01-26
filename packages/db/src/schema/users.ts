import { pgTable, uuid, text, boolean, timestamp } from 'drizzle-orm/pg-core';
import { userModeEnum, userStatusEnum } from './enums';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),

  // Auth (WorkOS)
  workosId: text('workos_id').unique().notNull(),
  email: text('email').unique().notNull(),
  emailVerified: boolean('email_verified').default(false).notNull(),

  // Profile
  firstName: text('first_name'),
  lastName: text('last_name'),
  avatarUrl: text('avatar_url'),
  phone: text('phone'),

  // Preferences
  activeMode: userModeEnum('active_mode').default('client').notNull(),
  timezone: text('timezone').default('UTC'),
  currency: text('currency').default('AUD'),

  // Status
  status: userStatusEnum('status').default('active').notNull(),

  // Timestamps
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  lastActiveAt: timestamp('last_active_at'),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
