import { pgTable, uuid, text, boolean, integer, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { companyRoleEnum } from './enums';
import { users } from './users';

export const companies = pgTable('companies', {
  id: uuid('id').primaryKey().defaultRandom(),

  name: text('name').notNull(),
  slug: text('slug').unique(),
  logoUrl: text('logo_url'),
  domain: text('domain'),

  isPersonal: boolean('is_personal').default(true).notNull(),

  creditBalance: integer('credit_balance').default(0).notNull(),
  stripeCustomerId: text('stripe_customer_id'),

  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const companyMembers = pgTable(
  'company_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .references(() => companies.id)
      .notNull(),
    userId: uuid('user_id')
      .references(() => users.id)
      .unique()
      .notNull(),

    role: companyRoleEnum('role').notNull().default('member'),

    invitedById: uuid('invited_by_id').references(() => users.id),
    joinedAt: timestamp('joined_at').defaultNow().notNull(),
  },
  (table) => ({
    companyUserIdx: uniqueIndex('company_user_idx').on(table.companyId, table.userId),
  })
);

// Relations
export const companiesRelations = relations(companies, ({ many }) => ({
  members: many(companyMembers),
}));

export const companyMembersRelations = relations(companyMembers, ({ one }) => ({
  company: one(companies, {
    fields: [companyMembers.companyId],
    references: [companies.id],
  }),
  user: one(users, {
    fields: [companyMembers.userId],
    references: [users.id],
  }),
}));

export type Company = typeof companies.$inferSelect;
export type NewCompany = typeof companies.$inferInsert;
export type CompanyMember = typeof companyMembers.$inferSelect;
