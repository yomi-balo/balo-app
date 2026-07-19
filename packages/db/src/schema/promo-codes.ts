import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { users } from './users';
import { companies } from './companies';
import { creditLedger } from './credit-ledger';
import { promoCodeStatusEnum } from './enums';
import { timestamps, softDelete } from './helpers';

/**
 * promo_codes (BAL-384 / ADR-1042) — the mintable, mutable promo-code entity. An
 * admin mints a code that grants a fixed slice of AUD credit per redemption, bounded
 * by a total redemption cap and a validity window. BAL-383 (the redeem path) is the
 * ONLY writer of `redeemed_count` and the ONLY inserter of `promo_redemptions`; this
 * ticket ships the schema + admin CRUD (mint / deactivate / cap-edit) only.
 *
 * INDEPENDENT ENTITY ⇒ it gets `...timestamps` AND `...softDelete` (unlike
 * `credit_wallets`, which is 1:1 with its parent). Nothing writes `deleted_at` this
 * ticket — it enables future safe code retirement + `code` reuse (see the PARTIAL
 * unique index below).
 *
 * Only `active` / `deactivated` are STORED (`promo_code_status`). `expired` /
 * `exhausted` / `scheduled` are DERIVED at read time from valid_until /
 * redeemed_count / valid_from — never persisted.
 */
export const promoCodes = pgTable(
  'promo_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Stored NORMALIZED (trim + uppercase) by the repository so uniqueness is
    // effectively case-insensitive (`welcome50` and `WELCOME50` collide).
    code: text('code').notNull(),

    // AUD minor units granted per redemption. A single config amount, well under
    // integer's ~$21M ceiling ⇒ `integer` (bigint headroom is only for accumulators).
    // CHECK `> 0` below.
    grantMinor: integer('grant_minor').notNull(),

    // Max TOTAL redemptions across all companies. CHECK `> 0`.
    perCodeRedemptionCap: integer('per_code_redemption_cap').notNull(),

    // Incremented by BAL-383 only. CHECK `>= 0` AND `<= per_code_redemption_cap`.
    redeemedCount: integer('redeemed_count').notNull().default(0),

    // Validity window (UI defaults valid_from to "now"). CHECK `valid_until > valid_from`.
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
    validUntil: timestamp('valid_until', { withTimezone: true }).notNull(),

    // Admin-controlled state only. Standalone CREATE TYPE ⇒ `default('active')` is safe.
    status: promoCodeStatusEnum('status').notNull().default('active'),

    // The minting admin. RESTRICT: attribution never orphans (mirrors
    // `audit_events.actor_user_id`).
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    // PARTIAL unique on active (non-deleted) rows only. Partial is MANDATORY: a
    // soft-delete + non-partial-unique = the silent re-create footgun (memory
    // reference_softdelete_nonpartial_unique_recreate). Also the backstop for the
    // duplicate-creation race.
    uniqueIndex('promo_codes_code_active_idx')
      .on(t.code)
      .where(sql`${t.deletedAt} IS NULL`),
    index('promo_codes_created_by_idx').on(t.createdBy),
    check('promo_codes_grant_positive', sql`${t.grantMinor} > 0`),
    check('promo_codes_cap_positive', sql`${t.perCodeRedemptionCap} > 0`),
    check('promo_codes_redeemed_nonneg', sql`${t.redeemedCount} >= 0`),
    // Defense-in-depth for BOTH the cap-lower CRUD guard (this ticket) and BAL-383's
    // increment. `CapBelowRedeemedCountError` is the friendly guard; this is the backstop.
    check('promo_codes_redeemed_within_cap', sql`${t.redeemedCount} <= ${t.perCodeRedemptionCap}`),
    check('promo_codes_valid_window', sql`${t.validUntil} > ${t.validFrom}`),
  ]
);

/**
 * promo_redemptions (BAL-384 / ADR-1042) — a DORMANT, append-only redemption ledger.
 * Additive, ZERO rows, and NO insert path this ticket: every redemption WRITE, the
 * `redeemed_count` increment, and runtime cap/single-use enforcement belong to
 * BAL-383 + BAL-378. The read tracking-view (BAL-384) reads it (empty until BAL-383).
 *
 * IMMUTABILITY: like `credit_ledger` (BAL-376) and `audit_events` (BAL-344), a
 * redemption is an immutable financial + attribution record — a single `redeemed_at`
 * timestamp, NO `updated_at`, NO `deleted_at`. A deliberate, documented exception to
 * the every-table created_at/updated_at/deleted_at convention (mutating or deleting a
 * money-attribution row would defeat the ledger).
 *
 * `company_id` (the redeeming PARTY, rights/ownership per ADR-1029) + `redeemed_by_user_id`
 * (the individual ACTOR per ADR-1030) is the symmetric party/person attribution — both
 * present from birth. A `promo` ledger entry is a SYSTEM entry (member_id null, no
 * `audit_events` row), so "who redeemed" has nowhere else to live but these columns.
 */
export const promoRedemptions = pgTable(
  'promo_redemptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // RESTRICT: never orphan a redemption from its code.
    promoCodeId: uuid('promo_code_id')
      .notNull()
      .references(() => promoCodes.id, { onDelete: 'restrict' }),

    // The redeeming PARTY (rights/ownership per ADR-1029; survives member departures).
    // `companies` has no `deleted_at` (memory reference_companies_table_no_deleted_at) —
    // joins don't filter it. RESTRICT.
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),

    // The single append timestamp (doubles as created_at).
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }).defaultNow().notNull(),

    // Snapshot of `promo_codes.grant_minor` at redemption (protects the record against
    // later grant edits). CHECK `> 0`.
    grantedMinor: integer('granted_minor').notNull(),

    // The `credit_ledger` row (reason `promo`, entry_type `adjustment`) that recorded the
    // grant. RESTRICT (`credit_ledger` is append-only, no soft-delete, so RESTRICT is
    // honourable). BAL-384 designs this column; BAL-383 populates it via `applyLedgerEntry`
    // in the same txn as the redemption insert.
    ledgerEntryId: uuid('ledger_entry_id')
      .notNull()
      .references(() => creditLedger.id, { onDelete: 'restrict' }),

    // ADR-1030 attribution column — the individual actor who redeemed. NULLABLE + RESTRICT
    // mirrors `credit_ledger.member_id` / `audit_events.actor_user_id` (a hypothetical future
    // auto-applied/system promo has no human actor).
    redeemedByUserId: uuid('redeemed_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
  },
  (t) => [
    index('promo_redemptions_promo_code_idx').on(t.promoCodeId),
    index('promo_redemptions_company_idx').on(t.companyId),
    index('promo_redemptions_redeemed_by_idx').on(t.redeemedByUserId),
    // One redemption per ledger entry. PLAIN (non-partial) unique is correct: neither side
    // is soft-deleted (append-only), so the soft-delete recreate footgun does not apply
    // (identical reasoning to `credit_ledger.idempotency_key`).
    uniqueIndex('promo_redemptions_ledger_entry_idx').on(t.ledgerEntryId),
    // Single-use PER COMPANY (BAL-377 / ADR-1040 Lane 1): at most one redemption of a given
    // code per redeeming party. PLAIN (non-partial) unique for the SAME reason as the
    // ledger-entry index — `promo_redemptions` is append-only with no soft-delete, so the
    // partial-unique recreate footgun does not apply. This is both the `validate` /
    // `redeem` single-use guarantee AND the concurrency backstop for the redeem race (the
    // `promoRedemptionsRepository.redeem` `onConflictDoNothing` arbiter → `already_redeemed`).
    uniqueIndex('promo_redemptions_company_code_idx').on(t.promoCodeId, t.companyId),
    check('promo_redemptions_granted_positive', sql`${t.grantedMinor} > 0`),
  ]
);

// ── Relations ──────────────────────────────────────────────────────────

export const promoCodesRelations = relations(promoCodes, ({ one, many }) => ({
  creator: one(users, {
    fields: [promoCodes.createdBy],
    references: [users.id],
  }),
  redemptions: many(promoRedemptions),
}));

export const promoRedemptionsRelations = relations(promoRedemptions, ({ one }) => ({
  promoCode: one(promoCodes, {
    fields: [promoRedemptions.promoCodeId],
    references: [promoCodes.id],
  }),
  company: one(companies, {
    fields: [promoRedemptions.companyId],
    references: [companies.id],
  }),
  ledgerEntry: one(creditLedger, {
    fields: [promoRedemptions.ledgerEntryId],
    references: [creditLedger.id],
  }),
  redeemer: one(users, {
    fields: [promoRedemptions.redeemedByUserId],
    references: [users.id],
  }),
}));

// ── Type exports ───────────────────────────────────────────────────────

export type PromoCode = typeof promoCodes.$inferSelect;
export type NewPromoCode = typeof promoCodes.$inferInsert;
export type PromoRedemption = typeof promoRedemptions.$inferSelect;
export type NewPromoRedemption = typeof promoRedemptions.$inferInsert;

/** Promo-code admin status (schema-derived — single source of truth). */
export type PromoCodeStatus = (typeof promoCodeStatusEnum.enumValues)[number];
