import { pgTable, uuid, char, text, timestamp } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { companies } from './companies';
import { users } from './users';

export const companyBillingDetails = pgTable('company_billing_details', {
  id: uuid('id').primaryKey().defaultRandom(),

  // One row per company, captured once ever, mutated in place. `.unique()` gives
  // the equality index that findByCompanyId uses AND is the onConflict target for
  // upsertByCompanyId (mirrors expert_payout_details.expertProfileId).
  companyId: uuid('company_id')
    .references(() => companies.id, { onDelete: 'cascade' })
    .notNull()
    .unique(),

  legalName: text('legal_name').notNull(),
  countryCode: char('country_code', { length: 2 }).notNull(),
  // Generic raw tax-id string. Country-specific label (ABN/VAT/EIN) is a
  // client-side presentational concern — NOT stored here.
  taxId: text('tax_id'),
  address: text('address'),
  billingEmail: text('billing_email').notNull(),

  // Attribution: who submitted/last-wrote the record. RESTRICT mirrors
  // proposal_documents.uploadedByUserId (preserve attribution; never orphan).
  submittedByUserId: uuid('submitted_by_user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),

  // Timestamps only — NO deletedAt (deliberate: single current fact per company,
  // last-write-wins). Inline form mirrors payouts.ts exactly (identical SQL to the
  // shared `...timestamps` helper).
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdateFn(() => new Date()),
});

// Relations
export const companyBillingDetailsRelations = relations(companyBillingDetails, ({ one }) => ({
  company: one(companies, {
    fields: [companyBillingDetails.companyId],
    references: [companies.id],
  }),
  submittedByUser: one(users, {
    fields: [companyBillingDetails.submittedByUserId],
    references: [users.id],
  }),
}));

export type CompanyBillingDetails = typeof companyBillingDetails.$inferSelect;
export type NewCompanyBillingDetails = typeof companyBillingDetails.$inferInsert;
