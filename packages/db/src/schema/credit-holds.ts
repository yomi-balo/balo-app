import {
  pgTable,
  uuid,
  integer,
  timestamp,
  index,
  check,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { creditWallets } from './credit-wallets';
import { creditSessions } from './credit-sessions';
import { users } from './users';
import { creditHoldStatusEnum } from './enums';
import { timestamps, softDelete } from './helpers';

/**
 * credit_holds (BAL-376 / ADR-1040) — reservations. A hold moves NO money; it only
 * reserves a slice of available balance while a Case is in flight. Available balance
 * = `credit_wallets.balance_minor − Σ active holds` (invariant #5), computed on read,
 * never persisted (there is deliberately no `available_minor` column).
 *
 * Mutable (status transitions), so `...timestamps` + `...softDelete` per convention —
 * though the terminal state is `status` (settled/released), not deletion; soft-delete
 * is rarely exercised. Holds do NOT write `credit_ledger` or `audit_events` this
 * ticket (a hold moves no money; ADR-1030 audit is for money actions).
 */
export const creditHolds = pgTable(
  'credit_holds',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // RESTRICT: never orphan a hold from its wallet.
    walletId: uuid('wallet_id')
      .notNull()
      .references(() => creditWallets.id, { onDelete: 'restrict' }),

    // FK added in BAL-378 → `credit_sessions.id` ON DELETE RESTRICT. Kept NULLABLE (a hold
    // is placed with a null session at `open`, then linked to the freshly-inserted session
    // in the same txn). All existing rows are NULL (BAL-378 is the first lane to write a
    // hold session_id), so ADD CONSTRAINT is safe. The `: AnyPgColumn` return annotation on
    // the thunk breaks the credit_holds ⇄ credit_sessions circular TYPE inference (TS7022).
    sessionId: uuid('session_id').references((): AnyPgColumn => creditSessions.id, {
      onDelete: 'restrict',
    }),

    // Attribution: the acting member. RESTRICT (never orphan attribution). Nullable.
    memberId: uuid('member_id').references(() => users.id, { onDelete: 'restrict' }),

    // Reserved amount (positive). A single reservation is bounded ⇒ `integer`.
    amountMinor: integer('amount_minor').notNull(),

    status: creditHoldStatusEnum('status').notNull().default('active'),

    // Set on settle/release.
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('credit_holds_wallet_idx').on(t.walletId),
    // The active-holds-by-wallet SUM path (invariant #5). Partial on the `'active'`
    // literal + `deleted_at IS NULL` — safe as a standalone `CREATE TYPE` (Decision 5),
    // and partial-on-deleted_at keeps the index tight.
    index('credit_holds_wallet_active_idx')
      .on(t.walletId)
      .where(sql`${t.status} = 'active' AND ${t.deletedAt} IS NULL`),
    check('credit_holds_amount_pos', sql`${t.amountMinor} > 0`),
  ]
);

// ── Relations ──────────────────────────────────────────────────────────

export const creditHoldsRelations = relations(creditHolds, ({ one }) => ({
  wallet: one(creditWallets, {
    fields: [creditHolds.walletId],
    references: [creditWallets.id],
  }),
  member: one(users, {
    fields: [creditHolds.memberId],
    references: [users.id],
  }),
}));

// ── Type exports ───────────────────────────────────────────────────────

export type CreditHold = typeof creditHolds.$inferSelect;
export type NewCreditHold = typeof creditHolds.$inferInsert;

/** Hold status (schema-derived — single source of truth). */
export type CreditHoldStatus = (typeof creditHoldStatusEnum.enumValues)[number];
