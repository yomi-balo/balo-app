import { pgTable, uuid, char, varchar, text, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { expertProfiles } from './experts';

// ── Domain constants ─────────────────────────────────────────
export const ENTITY_TYPES = ['PERSONAL', 'COMPANY'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const BENEFICIARY_STATUSES = ['verified', 'pending_verification', 'invalid'] as const;
export type BeneficiaryStatus = (typeof BENEFICIARY_STATUSES)[number];

export const expertPayoutDetails = pgTable(
  'expert_payout_details',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    expertProfileId: uuid('expert_profile_id')
      .references(() => expertProfiles.id, { onDelete: 'cascade' })
      .notNull()
      .unique(),

    countryCode: char('country_code', { length: 2 }).notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    transferMethod: varchar('transfer_method', { length: 10 }).notNull().default('LOCAL'),
    entityType: varchar('entity_type', { length: 10 }).notNull().default('COMPANY'),

    formValues: jsonb('form_values').notNull().$type<Record<string, string>>(),

    encryptedAccountNumber: text('encrypted_account_number'),
    encryptedIban: text('encrypted_iban'),
    encryptedRoutingNumber: text('encrypted_routing_number'),

    airwallexBeneficiaryId: text('airwallex_beneficiary_id'),
    beneficiaryRegisteredAt: timestamp('beneficiary_registered_at', { withTimezone: true }),
    beneficiaryStatus: text('beneficiary_status'),

    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    verifiedBy: uuid('verified_by'),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  () => ({
    // unique constraint is on the column via .unique() — no additional indexes needed
  })
);

// Relations
export const expertPayoutDetailsRelations = relations(expertPayoutDetails, ({ one }) => ({
  expertProfile: one(expertProfiles, {
    fields: [expertPayoutDetails.expertProfileId],
    references: [expertProfiles.id],
  }),
}));

export type ExpertPayoutDetails = typeof expertPayoutDetails.$inferSelect;
export type NewExpertPayoutDetails = typeof expertPayoutDetails.$inferInsert;
