import {
  pgTable,
  uuid,
  integer,
  text,
  timestamp,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { creditWallets } from './credit-wallets';
import { creditSessions } from './credit-sessions';
import { companies } from './companies';
import { creditReceivableStatusEnum, creditReceivableReasonEnum } from './enums';
import { timestamps, softDelete } from './helpers';

/**
 * credit_receivables (BAL-378 / ADR-1040 Lane 2) — an unrecovered overdraft after a
 * settlement FAILED (hard/async decline) or could not complete off-session (SCA). One row
 * per failed session (partial-unique on `session_id`, idempotent `open`).
 *
 * The "soft account hold" is DERIVED, not a column: a company is soft-held iff it has ANY
 * open receivable (`hasOpenReceivable`), which gates `openSession` (and the future
 * Case-create). No new `companies` column (avoids drift; `companies` has no `deleted_at`
 * anyway — memory `reference_companies_table_no_deleted_at`). Clearing the receivable
 * (status → `cleared`) releases the soft hold.
 *
 * Mutable, so `...timestamps` + `...softDelete`. NO RLS (ADR-1040 Decision 4).
 */
export const creditReceivables = pgTable(
  'credit_receivables',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Soft-hold scope. RESTRICT — `companies` has no soft-delete.
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),

    // Reconciliation. RESTRICT — never orphan a money row.
    walletId: uuid('wallet_id')
      .notNull()
      .references(() => creditWallets.id, { onDelete: 'restrict' }),

    // The failed session. RESTRICT.
    sessionId: uuid('session_id')
      .notNull()
      .references(() => creditSessions.id, { onDelete: 'restrict' }),

    // Unrecovered overdraft = terminal negative-balance magnitude (positive).
    amountMinor: integer('amount_minor').notNull(),

    reason: creditReceivableReasonEnum('reason').notNull(),
    status: creditReceivableStatusEnum('status').notNull().default('open'),

    // The failed / SCA PaymentIntent (recovery). Nullable.
    stripePaymentIntentId: text('stripe_payment_intent_id'),

    openedAt: timestamp('opened_at', { withTimezone: true }).defaultNow().notNull(),
    clearedAt: timestamp('cleared_at', { withTimezone: true }),
    // Dunning cadence anchor (null = never dunned since open).
    lastDunningAt: timestamp('last_dunning_at', { withTimezone: true }),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    // The `hasOpenReceivable` predicate — partial on the `'open'` literal + `deleted_at IS
    // NULL` (safe standalone `CREATE TYPE`).
    index('credit_receivables_company_open_idx')
      .on(t.companyId)
      .where(sql`${t.status} = 'open' AND ${t.deletedAt} IS NULL`),
    /**
     * BAL-548 / ADR-1055 — the `receivable.open` finder's index. The same partial space as
     * `credit_receivables_company_open_idx` above (and the same permitted `status = 'open'`
     * literal — an ORIGINAL label of `credit_receivable_status`, migration 0048), but keyed
     * on `opened_at`, because the alert read is PLATFORM-WIDE and oldest-first rather than
     * scoped to one company. The company-scoped index cannot serve it: it neither orders nor
     * bounds.
     */
    index('credit_receivables_open_queue_idx')
      .on(t.openedAt)
      .where(sql`${t.status} = 'open' AND ${t.deletedAt} IS NULL`),
    // At most one (non-deleted) receivable per session — idempotent `open`. Partial on
    // `deleted_at IS NULL` avoids the soft-delete non-partial-unique recreate footgun
    // (memory `reference_softdelete_nonpartial_unique_recreate`).
    //
    // ⚠⚠ ORDERING IS LOAD-BEARING — KEEP THIS UNIQUE LAST AMONG THE INDEXES, AND KEEP EVERY
    // `status`-NAMING INDEX ABOVE IT. Its status-blindness is fenced by
    // `invariants/an-account-hold-outlives-only-an-unpaid-balance.test.ts`, which scans from
    // this index's NAME to the next `;`. A `pgTable` index array contains NO semicolons, so
    // that window actually runs to the END of the table definition — meaning any LATER index
    // naming `status` trips the guard as a false positive even though this unique is
    // untouched. BAL-548 hit exactly that by first appending its index below this one. The
    // guard is coarser than its comment claims; this ordering is what keeps it honest.
    uniqueIndex('credit_receivables_session_uidx')
      .on(t.sessionId)
      .where(sql`${t.deletedAt} IS NULL`),
    check('credit_receivables_amount_pos', sql`${t.amountMinor} > 0`),
  ]
);

// ── Relations ──────────────────────────────────────────────────────────

export const creditReceivablesRelations = relations(creditReceivables, ({ one }) => ({
  company: one(companies, {
    fields: [creditReceivables.companyId],
    references: [companies.id],
  }),
  wallet: one(creditWallets, {
    fields: [creditReceivables.walletId],
    references: [creditWallets.id],
  }),
  session: one(creditSessions, {
    fields: [creditReceivables.sessionId],
    references: [creditSessions.id],
  }),
}));

// ── Type exports ───────────────────────────────────────────────────────

export type CreditReceivable = typeof creditReceivables.$inferSelect;
export type NewCreditReceivable = typeof creditReceivables.$inferInsert;

/** Receivable lifecycle status (schema-derived — single source of truth). */
export type CreditReceivableStatus = (typeof creditReceivableStatusEnum.enumValues)[number];
/** Receivable open-reason (schema-derived — single source of truth). */
export type CreditReceivableReason = (typeof creditReceivableReasonEnum.enumValues)[number];
