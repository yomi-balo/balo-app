import { pgTable, uuid, text, boolean, timestamp } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { userModeEnum, userStatusEnum, platformRoleEnum } from './enums';
import { companyMembers } from './companies';

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
  platformRole: platformRoleEnum('platform_role').default('user').notNull(),
  phone: text('phone'),

  // Preferences
  activeMode: userModeEnum('active_mode').default('client').notNull(),
  timezone: text('timezone').default('UTC'),
  currency: text('currency').default('AUD'),
  onboardingCompleted: boolean('onboarding_completed').default(false).notNull(),

  // Status
  status: userStatusEnum('status').default('active').notNull(),

  // Timestamps
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  lastActiveAt: timestamp('last_active_at'),
});

// Relations
export const usersRelations = relations(users, ({ many }) => ({
  companyMemberships: many(companyMembers),
}));

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
