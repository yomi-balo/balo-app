import {
  pgTable,
  uuid,
  bigint,
  integer,
  text,
  numeric,
  timestamp,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { creditWallets } from './credit-wallets';
import { users } from './users';
import { creditEntryTypeEnum, creditLedgerReasonEnum } from './enums';

/**
 * credit_ledger (BAL-376 / ADR-1040) — the APPEND-ONLY source of truth for every
 * money-affecting credit event. `credit_wallets.balance_minor` is a cache derived
 * from `SUM(amount_minor)` over this table (invariant #3).
 *
 * IMMUTABILITY: like `audit_events` (BAL-344) and per ADR-1030, this table is
 * genuinely append-only — a single `created_at`, NO `updated_at`, NO `deleted_at`.
 * Rows are only ever inserted; mutating or deleting a money row would defeat the
 * ledger. This is a deliberate, documented exception to the every-table
 * created_at/updated_at/deleted_at convention.
 *
 * `idempotency_key` is a plain (non-partial) `uniqueIndex` — correct BECAUSE
 * append-only rows are never soft-deleted/recreated, so the soft-delete +
 * non-partial-unique recreate footgun does not apply.
 */
export const creditLedger = pgTable(
  'credit_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Monotonic append-order key — a Postgres IDENTITY sequence, NOT the random UUID PK.
    // This is the ledger's canonical total order: `listByWallet` orders by `seq`, so
    // same-instant entries (Postgres `now()` is transaction-scoped, so several appends in
    // one txn TIE on `created_at`) still read back in the exact order they were appended —
    // a random-UUID tiebreaker would scramble them. GENERATED ALWAYS ⇒ never writer-set.
    seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(),

    // RESTRICT: never orphan a money row. The wallet has no soft-delete, so restrict
    // is honourable (a wallet only dies via its company CASCADE, which the app never
    // does while a ledger exists).
    walletId: uuid('wallet_id')
      .notNull()
      .references(() => creditWallets.id, { onDelete: 'restrict' }),

    // Coarse bucket + granular sub-reason — BOTH stated by the writer (no default).
    entryType: creditEntryTypeEnum('entry_type').notNull(),
    reason: creditLedgerReasonEnum('reason').notNull(),

    // Signed AUD minor units (+credit / −debit). The ONLY balance-affecting figure
    // (invariant #8). A single event is bounded well under $21M ⇒ `integer`. CHECK
    // `<> 0` below (a zero-money ledger row is meaningless).
    amountMinor: integer('amount_minor').notNull(),

    // Running-balance snapshot for reconciliation. `bigint({mode:'number'})` — the
    // second accumulator column (plan Decision 1). `SUM(integer)` in Postgres returns
    // bigint, so reconciliation never overflows.
    balanceAfterMinor: bigint('balance_after_minor', { mode: 'number' }).notNull(),

    // The acting member for consume/settlement attribution (ADR-1030). NULL for system
    // entries (auto_topup / dormancy_expiry / promo). RESTRICT (attribution FKs never
    // orphan) — reconciled with `audit_events.actor_user_id` (also nullable + restrict).
    memberId: uuid('member_id').references(() => users.id, { onDelete: 'restrict' }),

    // Links a Case's entries. NO FK this ticket — no `sessions`/`cases` table is in
    // scope; a bare uuid mirroring `audit_events.entity_id`. A later migration adds the
    // FK when the Case table lands (plan Open Q 5).
    sessionId: uuid('session_id'),

    // Immutable record of what the CARD was billed (e.g. 'GBP', 52000, 0.52). DISPLAY /
    // record only — NEVER in balance math (only `amount_minor` moves the balance).
    chargedCurrency: text('charged_currency'),
    chargedAmountMinor: integer('charged_amount_minor'),
    fxRate: numeric('fx_rate', { precision: 18, scale: 8 }),

    stripePaymentIntentId: text('stripe_payment_intent_id'),

    // Reconciliation triplet (invariant #3 / BAL-382 Decision A). The PaymentIntent can
    // own multiple charges (retries); the charge id + balance_transaction id pin the exact
    // settled money movement this row reconciles to (balance_transaction is where the
    // settled AUD amount + fx rate come from). DISPLAY / record only — NEVER in balance
    // math (excluded from `balanceContribution`), NEVER compared in `assertIdempotentMatch`
    // (like the existing charged_* / stripe PI fields). Nullable — system / AUD-only
    // entries legitimately null. Append-only table ⇒ new rows only ⇒ no backfill.
    stripeChargeId: text('stripe_charge_id'),
    stripeBalanceTransactionId: text('stripe_balance_transaction_id'),

    // State-derived (via `deriveIdempotencyKey`), NEVER a random UUID — Stripe replays
    // and BullMQ retries collapse to the same key. UNIQUE is the hard backstop behind
    // the advisory lock (invariant #4 / no double-credit).
    idempotencyKey: text('idempotency_key').notNull(),

    // The ONLY timestamp (append-only).
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('credit_ledger_idempotency_key_idx').on(t.idempotencyKey),
    // Per-wallet history in canonical append order (`listByWallet` orders by `seq`) +
    // the reconciliation SUM path (served by the `wallet_id` prefix).
    index('credit_ledger_wallet_idx').on(t.walletId, t.seq),
    // Session activity read.
    index('credit_ledger_session_idx').on(t.sessionId),
    check('credit_ledger_amount_nonzero', sql`${t.amountMinor} <> 0`),
    check(
      'credit_ledger_charged_amount_nonneg',
      sql`${t.chargedAmountMinor} IS NULL OR ${t.chargedAmountMinor} >= 0`
    ),
  ]
);

// ── Relations ──────────────────────────────────────────────────────────

export const creditLedgerRelations = relations(creditLedger, ({ one }) => ({
  wallet: one(creditWallets, {
    fields: [creditLedger.walletId],
    references: [creditWallets.id],
  }),
  member: one(users, {
    fields: [creditLedger.memberId],
    references: [users.id],
  }),
}));

// ── Type exports ───────────────────────────────────────────────────────

export type CreditLedgerEntry = typeof creditLedger.$inferSelect;
export type NewCreditLedgerEntry = typeof creditLedger.$inferInsert;

/** The coarse ledger bucket (schema-derived — single source of truth). */
export type CreditEntryType = (typeof creditEntryTypeEnum.enumValues)[number];
/** The granular ledger reason (schema-derived — single source of truth). */
export type CreditLedgerReason = (typeof creditLedgerReasonEnum.enumValues)[number];
