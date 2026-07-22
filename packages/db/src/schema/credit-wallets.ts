import {
  pgTable,
  uuid,
  bigint,
  integer,
  text,
  timestamp,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { companies } from './companies';
import { lowBalanceModeEnum, mandateStatusEnum } from './enums';
import { creditLedger } from './credit-ledger';
import { creditHolds } from './credit-holds';
import { timestamps } from './helpers';

/**
 * credit_wallets (BAL-376 / ADR-1040) — the mutable prepaid-balance projection,
 * ONE per client company. The company OWNS the wallet; the wallet's lifecycle IS
 * the company's.
 *
 * NO `deletedAt` (deliberate exception to the every-table soft-delete convention):
 * it is 1:1 with `companies`, which itself has no `deleted_at`
 * (memory `reference_companies_table_no_deleted_at`); a soft-delete guard would not
 * compile against the parent anyway. Omitting soft-delete ALSO sidesteps the
 * soft-delete + non-partial-unique recreate footgun on the `company_id` unique
 * (memory `reference_softdelete_nonpartial_unique_recreate`).
 *
 * `balance_minor` is a CACHE — always reconcilable to `SUM(credit_ledger.amount_minor)`
 * for the wallet (invariant #3), updated in the SAME `db.transaction` as its driving
 * ledger entry (see `applyLedgerEntry`).
 */
export const creditWallets = pgTable(
  'credit_wallets',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // One wallet per company (the equality-read index AND the onConflict target is the
    // named unique index below). CASCADE: the wallet dies with its company.
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    // Cached balance. `bigint({mode:'number'})` (NOT `integer`) for accumulator
    // headroom (plan Decision 1): a long-lived enterprise wallet could plausibly cross
    // integer's ~$21.4M AUD ceiling, and a silent wraparound on a real prepaid balance
    // is exactly the "money bug" ADR-1040 forbids. `mode:'number'` returns a JS number
    // (safe to 2^53 ≈ $90T). Per-event/config amounts below stay `integer`.
    balanceMinor: bigint('balance_minor', { mode: 'number' }).notNull().default(0),

    // Always 'AUD' — the credit subsystem is single-currency for balance math
    // (Decision 2). Uppercase per ADR-1040; never compared to engagements' lowercase
    // 'aud' (a different subsystem). CHECK below pins it.
    currency: text('currency').notNull().default('AUD'),

    // Rolling dormancy expiry = last ledger-affecting interaction + WALLET_EXPIRY_MONTHS
    // (12mo). NULL until the first ledger entry stamps it (`applyLedgerEntry` step 5).
    expiresAt: timestamp('expires_at', { withTimezone: true }),

    // NULLABLE — the overdraft check reads `?? DEFAULT_OVERDRAFT_CEILING_MINOR` at the
    // driving lane (this ticket does NOT gate overdraft). A single config amount is
    // bounded well under $21M ⇒ `integer`.
    overdraftCeilingMinor: integer('overdraft_ceiling_minor'),

    // Safe default: a new wallet has no card/mandate and CANNOT auto-top-up.
    lowBalanceMode: lowBalanceModeEnum('low_balance_mode').notNull().default('notify_only'),

    // Client-configurable auto-top-up band. Defaults mirror
    // DEFAULT_TOPUP_THRESHOLD_MINOR / DEFAULT_TOPUP_RELOAD_MINOR ($20 / $100).
    topupThresholdMinor: integer('topup_threshold_minor').notNull().default(2000),
    topupReloadMinor: integer('topup_reload_minor').notNull().default(10000),

    // Off-session mandate (card-funded). DISTINCT from `companies.stripe_customer_id`.
    // NEVER on a client-bound view — `CLIENT_WALLET_VIEW_COLUMNS` (credit-views.ts)
    // excludes both, and invariant #1 asserts it. Nullable (no card yet).
    stripePaymentMethodId: text('stripe_payment_method_id'),
    mandateRef: text('mandate_ref'),

    // Off-session mandate CUSTOMER (BAL-382 / Decision B) — DISTINCT from the legacy,
    // unused `companies.stripe_customer_id` column. The wallet mandate customer is
    // deliberately separate (see the mandate header note above). Nullable (no customer
    // until the first SetupIntent); persisted on `setup_intent.succeeded` via `applyMandate`
    // (alongside the payment method + mandate ref). `ensureCustomer` does NOT write it — it
    // only prevents duplicate Stripe customers on retry via a stable idempotency key. Kept
    // off client surfaces alongside the mandate secrets (invariant #1).
    stripeCustomerId: text('stripe_customer_id'),

    // Mandate lifecycle (BAL-382 / Decision B). pg enum, NULLABLE with NO default —
    // null = no mandate ever attempted (the natural state for existing wallets and a
    // brand-new wallet before any SetupIntent). Also off client surfaces (invariant #1).
    mandateStatus: mandateStatusEnum('mandate_status'),

    // BAL-379 — durable per-wallet auto-top-up single-in-flight marker. NULL = no auto-top-up
    // charge in flight. Set (under the wallet advisory lock) when the engine decides to charge a
    // reload; cleared by the success/fail webhook (or on a definite sync failure). While set AND
    // younger than TOPUP_IN_FLIGHT_TTL_MS, a second session cannot fire a concurrent reload — this
    // closes the "PI in flight but no ledger row yet" double-charge window (open() allows
    // below-threshold starts on the mandate, so a new session can end low before PI₁ settles). A
    // stale marker (older than the TTL) is a lost webhook, and a later crossing may re-fire. This
    // is INTERNAL operational state — NEVER on a client surface (excluded from the allow-list
    // CLIENT_WALLET_VIEW_COLUMNS).
    pendingTopupAt: timestamp('pending_topup_at', { withTimezone: true }),

    // Mutable projection ⇒ `updated_at` is correct. NO `...softDelete` (see header).
    ...timestamps,
  },
  (t) => [
    // One wallet per company: the by-company equality read AND the onConflict target.
    uniqueIndex('credit_wallets_company_idx').on(t.companyId),
    check('credit_wallets_currency_aud', sql`${t.currency} = 'AUD'`),
    check(
      'credit_wallets_overdraft_ceiling_nonneg',
      sql`${t.overdraftCeilingMinor} IS NULL OR ${t.overdraftCeilingMinor} >= 0`
    ),
    check('credit_wallets_topup_threshold_nonneg', sql`${t.topupThresholdMinor} >= 0`),
    check('credit_wallets_topup_reload_pos', sql`${t.topupReloadMinor} > 0`),
  ]
);

// ── Relations ──────────────────────────────────────────────────────────

export const creditWalletsRelations = relations(creditWallets, ({ one, many }) => ({
  company: one(companies, {
    fields: [creditWallets.companyId],
    references: [companies.id],
  }),
  ledger: many(creditLedger),
  holds: many(creditHolds),
}));

// ── Type exports ───────────────────────────────────────────────────────

export type CreditWallet = typeof creditWallets.$inferSelect;
export type NewCreditWallet = typeof creditWallets.$inferInsert;

/** Off-session mandate lifecycle (schema-derived — single source of truth, BAL-382). */
export type MandateStatus = (typeof mandateStatusEnum.enumValues)[number];

// NOTE: no `createInsertSchema` / `createSelectSchema` Zod exports here. `drizzle-zod`
// is NOT a dependency of `@balo/db` and NO existing schema file uses it (see the same
// note in `project-requests.ts`). Input validation for wallet config lives in the
// (later-lane) Server Action's own Zod schema; the `notNull()` columns, DB types, and
// the CHECK constraints above are the persistence-layer contract.
