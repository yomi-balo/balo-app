import {
  pgTable,
  uuid,
  bigint,
  integer,
  text,
  timestamp,
  index,
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

    // ── Saved-card DISPLAY facts (top-up redesign). ──────────────────────────
    // These are NOT secrets and NOT credentials: brand + last4 + expiry are exactly what a
    // checkout shows the cardholder about their own card, and none of them can be used to
    // charge anything. They exist so a returning buyer sees "Visa •••• 4242" instead of an
    // empty card form. DISTINCT from the mandate columns above, which ARE secrets: the id in
    // `stripe_payment_method_id` is what charges money; these four only render. They are
    // therefore the ONLY wallet columns added to `CLIENT_WALLET_VIEW_COLUMNS` alongside the
    // existing safe set — see that allow-list's docblock and `WALLET_SECRET_KEYS`.
    //
    // Written from TWO places, both webhook-side and both LAST-WRITER-WINS:
    //   · `setup_intent.succeeded`   → `applyMandate` (card-backed mode)
    //   · `payment_intent.succeeded` → `applySavedCardDisplay` (ANY manual_purchase, incl.
    //                                   `notify_only`, which never opens a SetupIntent)
    // Neither write ever sets `mandate_status = 'active'` off the back of a display update; and
    // `applySavedCardDisplay` CLEARS `mandate_status`/`mandate_ref` when the card it persists
    // differs from the one on file, so the mandate columns always describe the card they were
    // captured against. See `isWalletCardReusableOnSession` in `@balo/shared/credit` for the
    // (weaker) predicate these display columns enable — ON-SESSION reuse only.
    //
    // `integer` (not `bigint`) is right: a month, a year and a 4-char string. `cardLast4` is
    // `text`, not `varchar(4)` — the CHECK below is the contract, matching how `currency` is
    // pinned by `credit_wallets_currency_aud` rather than by a length type.
    cardBrand: text('card_brand'),
    cardLast4: text('card_last4'),
    cardExpMonth: integer('card_exp_month'),
    cardExpYear: integer('card_exp_year'),

    // BAL-515 — provenance of the saved-card DISPLAY facts above. NOT a display fact itself and
    // NOT on `CLIENT_WALLET_VIEW_COLUMNS`. NULL means "never refreshed since the row was
    // written", which is a legitimate state for every row migration 0080 already shipped.
    // Stamped with the DB `now()` (transaction time, no app↔DB clock skew) by every writer that
    // touches the four display columns: `applySavedCardDisplay`, `applyMandate` (only inside its
    // optional `card` branch), `refreshSavedCardDisplay` and `clearSavedCard`.
    //
    // ⚠ DELIBERATELY OUTSIDE `credit_wallets_card_display_all_or_none`. 0080 is already applied
    // in production, so rows exist with all four card columns populated and no timestamp. Adding
    // this column to the all-or-none arms would need a backfill and would fail on exactly those
    // rows — and the Testcontainers harness only ever migrates an EMPTY database, so that failure
    // would ship green. The existing constraint's comment below argues its own safety on every
    // arm having an all-NULL escape; a five-column version loses that property.
    cardUpdatedAt: timestamp('card_updated_at', { withTimezone: true }),

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

    // BAL-515 — the auto-top-up in-flight CORRELATION, written beside `pending_topup_at` so the
    // reconcile can name the crossing it is repairing. `pending_topup_at` alone is a bare
    // timestamp: it says a reload is in flight but not WHICH one, so nothing could derive the
    // ledger key `auto_topup:{walletId}:{triggeringEntryId}` and test it for absence — which is
    // what makes a charged-but-uncredited reload invisible once the marker self-heals.
    //
    // `pendingTopupTriggeringEntryId` is ARMED in the engine's phase-1 advisory-locked txn (it is
    // known there); `pendingTopupPaymentIntentId` is stamped immediately after the phase-2 charge
    // returns `processing` (the PaymentIntent id does not exist until then). Both are cleared
    // together with `pending_topup_at` by `clearPendingTopup`.
    //
    // NO FOREIGN KEY on the entry id, deliberately: `credit_ledger` is append-only and never
    // deleted, so an FK would never fire; this is a transient operational POINTER cleared on
    // every resolution, not a relationship; and adding an FK takes a validating lock on a
    // non-empty production table for zero benefit. Same posture as `meeting_contexts.context_id`.
    //
    // INTERNAL operational state — NEVER on a client surface (both excluded from the allow-list
    // `CLIENT_WALLET_VIEW_COLUMNS`, exactly like `pending_topup_at`).
    pendingTopupTriggeringEntryId: uuid('pending_topup_triggering_entry_id'),
    pendingTopupPaymentIntentId: text('pending_topup_payment_intent_id'),

    // Mutable projection ⇒ `updated_at` is correct. NO `...softDelete` (see header).
    ...timestamps,
  },
  (t) => [
    // One wallet per company: the by-company equality read AND the onConflict target.
    uniqueIndex('credit_wallets_company_idx').on(t.companyId),
    // BAL-515 — the auto-top-up reconcile finder (`findStuckPendingTopups`, oldest marker
    // first). PARTIAL on the marker so the index only carries wallets with a reload actually in
    // flight — a tiny fraction of a table that is already one row per company.
    index('credit_wallets_pending_topup_idx')
      .on(t.pendingTopupAt)
      .where(sql`${t.pendingTopupAt} IS NOT NULL`),
    // BAL-515 — the `payment_method.*` webhook arms' wallet lookup
    // (`listByStripePaymentMethodId`). NON-UNIQUE on purpose: no constraint forbids two wallets
    // naming one payment method, so a UNIQUE index would abort this migration on any pre-existing
    // duplicate — a hazard the empty-DB Testcontainers harness cannot surface. The reader returns
    // an ARRAY and its caller refuses to act on ambiguity instead.
    index('credit_wallets_stripe_payment_method_idx')
      .on(t.stripePaymentMethodId)
      .where(sql`${t.stripePaymentMethodId} IS NOT NULL`),
    check('credit_wallets_currency_aud', sql`${t.currency} = 'AUD'`),
    check(
      'credit_wallets_overdraft_ceiling_nonneg',
      sql`${t.overdraftCeilingMinor} IS NULL OR ${t.overdraftCeilingMinor} >= 0`
    ),
    check('credit_wallets_topup_threshold_nonneg', sql`${t.topupThresholdMinor} >= 0`),
    check('credit_wallets_topup_reload_pos', sql`${t.topupReloadMinor} > 0`),
    // ── Saved-card display CHECKs (top-up redesign) ──────────────────────────
    // All four display fields move together — we only ever write them from one narrowing
    // (`pm.type === 'card'` with a populated `pm.card`), so a partial row is a bug, not a
    // state. Every constraint below has an all-NULL / `IS NULL OR …` arm, so EVERY existing
    // wallet row satisfies all four as written: the migration needs no backfill and cannot
    // fail on a non-empty database (the Testcontainers harness only ever migrates an empty
    // one, so this property is argued here rather than proven there).
    check(
      'credit_wallets_card_display_all_or_none',
      sql`(${t.cardBrand} IS NULL AND ${t.cardLast4} IS NULL AND ${t.cardExpMonth} IS NULL AND ${t.cardExpYear} IS NULL)
          OR (${t.cardBrand} IS NOT NULL AND ${t.cardLast4} IS NOT NULL AND ${t.cardExpMonth} IS NOT NULL AND ${t.cardExpYear} IS NOT NULL)`
    ),
    check(
      'credit_wallets_card_last4_format',
      sql`${t.cardLast4} IS NULL OR ${t.cardLast4} ~ '^[0-9]{4}$'`
    ),
    check(
      'credit_wallets_card_exp_month_range',
      sql`${t.cardExpMonth} IS NULL OR (${t.cardExpMonth} BETWEEN 1 AND 12)`
    ),
    check(
      'credit_wallets_card_exp_year_range',
      sql`${t.cardExpYear} IS NULL OR (${t.cardExpYear} BETWEEN 2000 AND 2100)`
    ),
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
