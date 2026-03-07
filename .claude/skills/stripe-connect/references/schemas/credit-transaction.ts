// credit-transaction.ts
// Drizzle schema for credit_transactions table
// This table is the complete audit trail for all credit movements.

import {
  pgTable,
  pgEnum,
  uuid,
  integer,
  varchar,
  timestamp,
} from 'drizzle-orm/pg-core';
import { users } from './users';
import { cases } from './cases';
import { meetings } from './meetings';

export const creditTransactionTypeEnum = pgEnum('credit_transaction_type', [
  'purchase',    // Client buys credits via Stripe Checkout
  'consumption', // Credits used during consultation (per-minute billing)
  'refund',      // Credits returned to client (dispute, cancellation)
  'promo',       // Promotional credits (referral bonus, coupon, admin gift)
  'expiry',      // Credits expired (if expiry policy enabled)
  'adjustment',  // Manual admin adjustment (support case resolution)
]);

export const creditTransactions = pgTable('credit_transactions', {
  id: uuid('id').primaryKey().defaultRandom(),

  // Who
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),

  // What
  type: creditTransactionTypeEnum('type').notNull(),
  amount: integer('amount').notNull(), // Positive = credits in, negative = credits out
  balanceAfter: integer('balance_after').notNull(), // Snapshot after this tx (for audit)
  description: varchar('description', { length: 500 }),

  // Stripe references (null for promo/adjustment)
  stripePaymentIntentId: varchar('stripe_payment_intent_id', { length: 255 }),
  stripeTransferId: varchar('stripe_transfer_id', { length: 255 }),

  // Context
  caseId: uuid('case_id').references(() => cases.id),
  meetingId: uuid('meeting_id').references(() => meetings.id),

  // Idempotency — prevents double-processing on webhook retries
  idempotencyKey: varchar('idempotency_key', { length: 255 }).unique(),

  // Timestamp
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Note: users.credit_balance is a denormalized column kept in sync by addCredits()
// It exists for fast balance reads — never query sum(amount) in the hot path.
