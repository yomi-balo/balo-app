import {
  pgTable,
  uuid,
  integer,
  text,
  timestamp,
  index,
  check,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { creditWallets } from './credit-wallets';
import { creditHolds } from './credit-holds';
import { companies } from './companies';
import { expertProfiles } from './experts';
import { users } from './users';
import { creditSessionStatusEnum, creditSettlementStatusEnum } from './enums';
import { timestamps, softDelete } from './helpers';

/**
 * credit_sessions (BAL-378 / ADR-1040 Lane 2) — the CREDIT ENVELOPE of a per-minute
 * consultation (NOT the video room / full Case object, which are future Booking work).
 * A row owns the full money lifecycle of a Case: pre-connect funds-or-mandate gate + hold
 * → per-minute `session_consume` metering → grace state machine (30 min OR company
 * ceiling) → end → single session-keyed overdraft settlement → an expert-earned accrual
 * recorded INDEPENDENT of settlement (the "expert-always-paid" guarantee).
 *
 * `credit_sessions.id` is the value FK-resolved into `credit_ledger.session_id` and
 * `credit_holds.session_id` (both nullable, wired in this same migration).
 *
 * Mutable (status transitions), so `...timestamps` + `...softDelete` per convention —
 * though the terminal state is `status` (ended/cancelled), deletion is rare.
 *
 * NO RLS (ADR-1040 Decision 4, matching credit_wallets/ledger/holds): the fee/PII
 * boundary is enforced at the PROJECTION layer (`toClientSessionView` /
 * `deriveDrawdownState`) + invariant tests, NOT RLS. A client-bound read MUST exclude
 * `expertRate*`, `baloFeeBps`, `expertAccruedMinor`, `stripePaymentIntentId`.
 */
export const creditSessions = pgTable(
  'credit_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // RESTRICT on every FK — never orphan a money row (the wallet only dies via its
    // company CASCADE, which the app never does while a session exists).
    walletId: uuid('wallet_id')
      .notNull()
      .references(() => creditWallets.id, { onDelete: 'restrict' }),

    // Denormalised capability scope + notification fan-out subject. `companies` has NO
    // `deleted_at` (memory `reference_companies_table_no_deleted_at`), so RESTRICT.
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),

    // The expert — accrual subject + display.
    expertProfileId: uuid('expert_profile_id')
      .notNull()
      .references(() => expertProfiles.id, { onDelete: 'restrict' }),

    // The acting member — attribution on every session_consume / overdraft_settlement
    // ledger row (satisfies the `applyLedgerEntry` memberId dev-guard) + the accrual audit.
    initiatingMemberId: uuid('initiating_member_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    // The pre-connect reservation (set at `open`; released at `end`/`cancel`). Nullable.
    // The `: AnyPgColumn` return annotation on the thunk is Drizzle's documented fix for a
    // MUTUAL FK cycle — credit_holds.sessionId also points at credit_sessions.id, and an
    // un-annotated inline reference on both sides makes TypeScript infer the two table types
    // circularly (TS7022). Annotating the thunk return breaks that without changing the SQL.
    holdId: uuid('hold_id').references((): AnyPgColumn => creditHolds.id, { onDelete: 'restrict' }),

    status: creditSessionStatusEnum('status').notNull().default('pending'),
    settlementStatus: creditSettlementStatusEnum('settlement_status')
      .notNull()
      .default('not_required'),

    // ── Snapshots (immutable for the life of the session; economics never drift) ──
    // Sizes the hold (estimated MAX cost).
    estimatedMinutes: integer('estimated_minutes').notNull(),
    // Raw expert quote snapshot (reconciliation/audit). NEVER on a client view.
    expertRateMinorPerHour: integer('expert_rate_minor_per_hour').notNull(),
    // Fee snapshot (BAL-357 pattern; audience-keyed). NEVER on a client view.
    baloFeeBps: integer('balo_fee_bps').notNull().default(2500),
    // MARKED-UP per-minute charge — drives drawdown + the widget "A$rate/min".
    clientRateMinorPerMinute: integer('client_rate_minor_per_minute').notNull(),
    // RAW per-minute — drives the expert accrual. NEVER on a client view.
    expertRateMinorPerMinute: integer('expert_rate_minor_per_minute').notNull(),
    // `wallet.overdraftCeilingMinor ?? DEFAULT_OVERDRAFT_CEILING_MINOR` snapshot.
    effectiveCeilingMinor: integer('effective_ceiling_minor').notNull(),
    // `OVERDRAFT_GRACE_MINUTES` snapshot.
    graceBoundMinutes: integer('grace_bound_minutes').notNull().default(30),

    // ── Metering state ──
    // Drawdown clock origin (metering anchor). Null until `connect`.
    connectedAt: timestamp('connected_at', { withTimezone: true }),
    // Highest whole-minute metered (idempotency resume anchor).
    lastTickSeq: integer('last_tick_seq').notNull().default(0),
    // Charged minutes (= lastTickSeq while active/grace).
    connectedMinutes: integer('connected_minutes').notNull().default(0),
    // Expert-always-paid accrual = connectedMinutes × expertRateMinorPerMinute; finalized
    // at `end` INDEPENDENT of settlement. NEVER on a client view (raw expert economics).
    expertAccruedMinor: integer('expert_accrued_minor').notNull().default(0),

    // ── One-shot markers (set once, the first time their condition holds) ──
    lowWarnedAt: timestamp('low_warned_at', { withTimezone: true }),
    graceEnteredAt: timestamp('grace_entered_at', { withTimezone: true }),
    nearWrapWarnedAt: timestamp('near_wrap_warned_at', { withTimezone: true }),
    wrappedAt: timestamp('wrapped_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    settledAt: timestamp('settled_at', { withTimezone: true }),

    // Terminal negative-balance magnitude at `end` (the settlement basis; promo excluded
    // by construction). Null until ended.
    overdraftSettledMinor: integer('overdraft_settled_minor'),

    // Settlement PaymentIntent (reconciliation; NEVER client-facing).
    stripePaymentIntentId: text('stripe_payment_intent_id'),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('credit_sessions_wallet_idx').on(t.walletId),
    index('credit_sessions_company_idx').on(t.companyId),
    // The reaper's hot path — meter only active/grace sessions. Partial on enum literals +
    // `deleted_at IS NULL` is SAFE (the `credit_holds_wallet_active_idx` precedent).
    index('credit_sessions_meter_idx')
      .on(t.status)
      .where(sql`${t.status} IN ('active', 'grace') AND ${t.deletedAt} IS NULL`),
    // Reconciliation of stuck settlements (findStuckSettling).
    index('credit_sessions_settling_idx')
      .on(t.settlementStatus)
      .where(sql`${t.settlementStatus} = 'processing'`),
    check('credit_sessions_estimated_minutes_pos', sql`${t.estimatedMinutes} > 0`),
    check('credit_sessions_expert_hourly_pos', sql`${t.expertRateMinorPerHour} > 0`),
    check('credit_sessions_client_minute_pos', sql`${t.clientRateMinorPerMinute} > 0`),
    check('credit_sessions_expert_minute_pos', sql`${t.expertRateMinorPerMinute} > 0`),
    check('credit_sessions_ceiling_nonneg', sql`${t.effectiveCeilingMinor} >= 0`),
    check(
      'credit_sessions_balo_fee_bps_range',
      sql`${t.baloFeeBps} >= 0 AND ${t.baloFeeBps} <= 10000`
    ),
    check(
      'credit_sessions_overdraft_settled_nonneg',
      sql`${t.overdraftSettledMinor} IS NULL OR ${t.overdraftSettledMinor} >= 0`
    ),
  ]
);

// ── Relations ──────────────────────────────────────────────────────────

export const creditSessionsRelations = relations(creditSessions, ({ one }) => ({
  wallet: one(creditWallets, {
    fields: [creditSessions.walletId],
    references: [creditWallets.id],
  }),
  company: one(companies, {
    fields: [creditSessions.companyId],
    references: [companies.id],
  }),
  expertProfile: one(expertProfiles, {
    fields: [creditSessions.expertProfileId],
    references: [expertProfiles.id],
  }),
  initiatingMember: one(users, {
    fields: [creditSessions.initiatingMemberId],
    references: [users.id],
  }),
  hold: one(creditHolds, {
    fields: [creditSessions.holdId],
    references: [creditHolds.id],
  }),
}));

// ── Type exports ───────────────────────────────────────────────────────

export type CreditSession = typeof creditSessions.$inferSelect;
export type NewCreditSession = typeof creditSessions.$inferInsert;

/** Session lifecycle status (schema-derived — single source of truth). */
export type CreditSessionStatus = (typeof creditSessionStatusEnum.enumValues)[number];
/** Settlement outcome status (schema-derived — single source of truth). */
export type CreditSettlementStatus = (typeof creditSettlementStatusEnum.enumValues)[number];
