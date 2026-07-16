import { pgTable, uuid, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * stripe_webhook_events (BAL-382) — the event-id idempotency log for the single Stripe
 * webhook endpoint.
 *
 * APPEND-ONLY: a deliberate exception to the every-table timestamps/soft-delete
 * convention (same class as `credit_ledger.ts` and `audit_events`) — rows are inserted
 * once and never mutated except the one-shot `processed_at` stamp, and are never
 * soft-deleted. Hence NO `...timestamps` / `...softDelete` spread.
 *
 * NO RLS (Decision F): matches the credit subsystem's no-RLS posture (ADR-1040
 * Decision 4 — no credit table calls `.enableRLS()`). This table is an internal
 * idempotency log reached ONLY by the signature-verified webhook via the admin `db`
 * client; a user never queries it, and the admin client bypasses RLS anyway, so adding
 * a policy here would be both inconsistent with its siblings and inert.
 *
 * Surrogate UUID PK + a UNIQUE index on the natural Stripe event id — mirrors
 * `credit_ledger`'s (uuid id) + (unique idempotency_key) precedent, so
 * `onConflictDoNothing` keys on `event_id`. The unique index is NON-partial and correct:
 * the table is append-only (never soft-deleted/recreated), so the soft-delete +
 * non-partial-unique recreate footgun does not apply.
 */
export const stripeWebhookEvents = pgTable(
  'stripe_webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // The Stripe event id (`evt_...`) — the natural idempotency key.
    eventId: text('event_id').notNull(),
    // The Stripe event type (e.g. 'payment_intent.succeeded').
    type: text('type').notNull(),
    // Optional integrity check of the raw payload.
    payloadHash: text('payload_hash'),
    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
    // Stamped atomically with the effect (a persisted marker implies a committed effect).
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('stripe_webhook_events_event_id_idx').on(t.eventId)]
);

// ── Type exports ───────────────────────────────────────────────────────

export type StripeWebhookEvent = typeof stripeWebhookEvents.$inferSelect;
export type NewStripeWebhookEvent = typeof stripeWebhookEvents.$inferInsert;
