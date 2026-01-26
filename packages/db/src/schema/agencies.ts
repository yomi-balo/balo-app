import { pgTable, uuid, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { agencyRoleEnum } from './enums';
import { users } from './users';

export const agencies = pgTable('agencies', {
  id: uuid('id').primaryKey().defaultRandom(),

  name: text('name').notNull(),
  slug: text('slug').unique(),
  logoUrl: text('logo_url'),

  stripeConnectId: text('stripe_connect_id'),

  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const agencyMembers = pgTable(
  'agency_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agencyId: uuid('agency_id')
      .references(() => agencies.id)
      .notNull(),
    userId: uuid('user_id')
      .references(() => users.id)
      .notNull(),

    role: agencyRoleEnum('role').notNull().default('expert'),

    invitedById: uuid('invited_by_id').references(() => users.id),
    joinedAt: timestamp('joined_at').defaultNow().notNull(),
  },
  (table) => ({
    agencyUserIdx: uniqueIndex('agency_user_idx').on(table.agencyId, table.userId),
  })
);

// Relations
export const agenciesRelations = relations(agencies, ({ many }) => ({
  members: many(agencyMembers),
}));

export const agencyMembersRelations = relations(agencyMembers, ({ one }) => ({
  agency: one(agencies, {
    fields: [agencyMembers.agencyId],
    references: [agencies.id],
  }),
  user: one(users, {
    fields: [agencyMembers.userId],
    references: [users.id],
  }),
}));

export type Agency = typeof agencies.$inferSelect;
export type AgencyMember = typeof agencyMembers.$inferSelect;
