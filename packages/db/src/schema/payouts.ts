import {
  pgTable,
  uuid,
  char,
  varchar,
  text,
  jsonb,
  integer,
  timestamp,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { expertProfiles } from './experts';
import { companies } from './companies';
import { creditSessions } from './credit-sessions';
import { creditFinalizationPathEnum, expertPayoutRecordStatusEnum } from './enums';
import { timestamps, softDelete } from './helpers';

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
    tradingName: text('trading_name'),

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

/**
 * expert_payout_records (BAL-399 / ADR-1043) — the expert PAYOUT OBLIGATION booked at a
 * consultation's billing finalization. One row per finalized `credit_sessions` row. BAL-378
 * already finalizes `credit_sessions.expertAccruedMinor` (the expert-always-paid accrual)
 * terminally at `end()`; this table simply RECORDS that obligation idempotently so a later
 * Airwallex payout-run (BAL-202/203) can consume `status='recorded'` rows and disburse. NO
 * Airwallex transfer happens in BAL-399 — this is only the ledger of what is owed.
 *
 * `amountMinor` is a READ of `credit_sessions.expertAccruedMinor` at finalization — NEVER
 * re-derived from minutes (the snapshotted accrual is the single source of truth). RESTRICT on
 * every FK: a money row must never be orphaned (companies has NO `deleted_at`, memory
 * `reference_companies_table_no_deleted_at`, so RESTRICT there too).
 *
 * NO RLS (ADR-1040 Decision 4, matching credit_sessions/wallets/ledger/holds): access is
 * gated at the application layer + fee-safe projections, not RLS. This is an expert-own-side
 * money row (own earnings only) — it carries no client charge / markup / margin.
 */
export const expertPayoutRecords = pgTable(
  'expert_payout_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // One payout obligation per session (partial-unique below). RESTRICT — never orphan.
    sessionId: uuid('session_id')
      .notNull()
      .references(() => creditSessions.id, { onDelete: 'restrict' }),
    // The expert paid — accrual subject + payout-run target.
    expertProfileId: uuid('expert_profile_id')
      .notNull()
      .references(() => expertProfiles.id, { onDelete: 'restrict' }),
    // Context / fan-out subject. `companies` has NO `deleted_at` → RESTRICT.
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),

    // = credit_sessions.expertAccruedMinor READ AT FINALIZATION. Never re-derived from minutes.
    amountMinor: integer('amount_minor').notNull(),
    currency: char('currency', { length: 3 }).notNull().default('AUD'),
    // connectedMinutes snapshot (analytics duration_min + receipt copy).
    durationMinutes: integer('duration_minutes').notNull(),
    finalizationPath: creditFinalizationPathEnum('finalization_path').notNull(),
    status: expertPayoutRecordStatusEnum('status').notNull().default('recorded'),
    // Deterministic dedup key `payout:${sessionId}` — the belt to the partial-unique suspenders.
    idempotencyKey: text('idempotency_key').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    // Soft-delete-safe single-obligation-per-session (memory
    // `reference_softdelete_nonpartial_unique_recreate`): PARTIAL unique on `deleted_at IS
    // NULL` so a soft-deleted + re-recorded obligation can re-insert. The `record`
    // `onConflictDoNothing` arbiter matches this predicate exactly.
    uniqueIndex('expert_payout_records_session_uq')
      .on(t.sessionId)
      .where(sql`${t.deletedAt} IS NULL`),
    // Second belt on the deterministic key (also partial for the same soft-delete re-record).
    uniqueIndex('expert_payout_records_idem_uq')
      .on(t.idempotencyKey)
      .where(sql`${t.deletedAt} IS NULL`),
    index('expert_payout_records_expert_idx').on(t.expertProfileId),
    // Future payout-run finder (BAL-202): status='recorded' AND deleted_at IS NULL. Partial on
    // the enum literal + deleted_at is SAFE (standalone CREATE TYPE, per the credit precedents).
    index('expert_payout_records_status_idx')
      .on(t.status)
      .where(sql`${t.status} = 'recorded' AND ${t.deletedAt} IS NULL`),
    check('expert_payout_records_amount_nonneg', sql`${t.amountMinor} >= 0`),
    check('expert_payout_records_duration_nonneg', sql`${t.durationMinutes} >= 0`),
  ]
);

// Relations
export const expertPayoutRecordsRelations = relations(expertPayoutRecords, ({ one }) => ({
  session: one(creditSessions, {
    fields: [expertPayoutRecords.sessionId],
    references: [creditSessions.id],
  }),
  expertProfile: one(expertProfiles, {
    fields: [expertPayoutRecords.expertProfileId],
    references: [expertProfiles.id],
  }),
  company: one(companies, {
    fields: [expertPayoutRecords.companyId],
    references: [companies.id],
  }),
}));

export type ExpertPayoutRecord = typeof expertPayoutRecords.$inferSelect;
export type NewExpertPayoutRecord = typeof expertPayoutRecords.$inferInsert;

/** Expert payout obligation lifecycle (schema-derived — single source of truth). */
export type ExpertPayoutRecordStatus = (typeof expertPayoutRecordStatusEnum.enumValues)[number];
