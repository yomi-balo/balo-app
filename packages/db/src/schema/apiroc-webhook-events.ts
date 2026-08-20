import { pgTable, uuid, text, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { calendarSubscriptions } from './calendar';

/**
 * `apiroc_webhook_events` (BAL-468) — the `svix-id` idempotency log for the inbound Apiroc
 * calendar-change webhook (`POST /webhooks/apiroc/calendar/:calendarSubscriptionId`). A
 * DELIBERATE MIRROR of `daily_webhook_events` (BAL-134, D2) and `stripe_webhook_events`
 * (BAL-382), down to the column set, so a reviewer who knows either knows this one.
 *
 * ⚠ WHAT IT IS AND IS NOT LOAD-BEARING FOR, TODAY. Be honest about this rather than letting
 * someone discover it: the webhook's ONLY effect is enqueuing an availability rebuild under
 * the BullMQ jobId `availability-${expertProfileId}`, which already coalesces duplicate
 * deliveries into one job. So this table is not yet the thing preventing a double effect —
 * it is the AUDIT TRAIL (which subscription delivered, when, and was it acted on) and the
 * cheap short-circuit that stops a replay from re-entering the enqueue path. It becomes
 * mandatory the moment this webhook grows a SECOND effect, which is exactly why it is built
 * now rather than retrofitted onto a path that has already shipped one.
 *
 * ⚠⚠ BRANCH ON `processed_at`, NOT ON ROW PRESENCE. A row whose `processed_at` is NULL is a
 * delivery that was received and then DIED before its effect landed. Treating any row as
 * "already handled" would permanently suppress the retry that exists to repair it — the
 * endpoint would answer 2xx forever to a change it never acted on.
 *
 * APPEND-ONLY: a deliberate exception to the every-table timestamps/soft-delete convention,
 * in the same class as `stripe_webhook_events`, `daily_webhook_events`, `credit_ledger` and
 * `audit_events`. Rows are inserted once and mutated only by the one-shot `processed_at`
 * stamp, and are never soft-deleted. Hence NO `...timestamps` / `...softDelete` spread. A
 * "consistency" pass that adds them would silently break the safety argument for the unique
 * index below; `apiroc-webhook-events.integration.test.ts` pins the exact column set so it
 * fails loudly instead.
 *
 * ⚠ THE UNIQUE INDEX IS NON-PARTIAL, AND THAT IS SAFE **BECAUSE** THE TABLE IS APPEND-ONLY.
 * The soft-delete + non-partial-unique recreate footgun (memory
 * `reference_softdelete_nonpartial_unique_recreate`) needs a soft-delete to bite: a row
 * stamped `deleted_at` that keeps occupying its unique key blocks the re-create. There is no
 * `deleted_at` here and no writer that could add one, so a partial predicate would guard a
 * state that CANNOT EXIST — while COSTING correctness, since the arbiter would then be
 * partial and every `onConflictDoNothing` on it would have to restate the predicate with
 * INLINED literals or fail 42P10 (memory
 * `reference_pg_partial_index_arbiter_param_42p10`). Non-partial is both the simpler and the
 * stricter choice here. Contrast `calendar_subscriptions`, which DOES soft-delete and whose
 * unique is therefore partial — the two tables differ on purpose.
 *
 * ⚠ NO RLS, matching `stripe_webhook_events`, `daily_webhook_events` and the whole calendar
 * family. An internal idempotency log reached ONLY by the signature-verified webhook through
 * the admin `db` client, which bypasses RLS anyway.
 *
 * RETENTION: unbounded, exactly like its two shipped siblings. At the observed coalescing
 * rate a 1,000-subscription fleet writes on the order of 10^4–10^5 rows/month. Acceptable
 * for now; a single retention rule shared across all three marker tables is the right shape
 * and is a follow-up, not this ticket.
 */
export const apirocWebhookEvents = pgTable(
  'apiroc_webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Svix's message id from the `svix-id` header (e.g. `msg_3HtgzMfGgWuizxqYyI5IcsFymLA`) —
     * the natural idempotency key, and the only thing that makes a replay distinguishable
     * from a genuine second change on the same calendar.
     *
     * `text`, NOT `uuid`: it is a VENDOR string whose format is Svix's to change, and a type
     * that rejected a reformatted id would turn a cosmetic vendor change into a webhook
     * outage.
     */
    svixId: text('svix_id').notNull(),
    /**
     * Which subscription delivered. `NOT NULL` with a real FK — unlike
     * `daily_webhook_events.room_name` (nullable, no FK), a marker here is only ever written
     * AFTER the path resolved to a live subscription row and the signature verified, so the
     * value is always known.
     *
     * ⚠ FOR THE OPS READ AND THE LIVENESS JOIN ONLY. It is NEVER the thing that resolves the
     * expert — that is `connection_id → expert_profile_id`, one hop off
     * `calendar_subscriptions`.
     */
    calendarSubscriptionId: uuid('calendar_subscription_id')
      .notNull()
      .references(() => calendarSubscriptions.id, { onDelete: 'cascade' }),
    /**
     * The Apiroc event type as delivered. ⚠ `calendar.event.changed` is the ONLY type ever
     * observed [live], and the only one the route treats as actionable
     * (`KNOWN_EVENT_TYPE`). The vendor documents `calendar.event.unknown` and an
     * `enduseraccount.*` family [docs], so the column stores whatever arrives rather than
     * switching on a closed set — but a reader debugging this table should expect
     * `calendar.event.changed` and essentially nothing else.
     */
    eventType: text('event_type').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
    /**
     * Stamped once the effect (the availability-rebuild enqueue) has actually landed. A
     * persisted stamp means "already applied, do nothing"; a marker WITHOUT one means a prior
     * delivery died mid-flight and the effect is still owed. See the ⚠⚠ above.
     */
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('apiroc_webhook_events_svix_id_idx').on(t.svixId),
    /** The ops read: "what has this subscription delivered, most recent first". */
    index('apiroc_webhook_events_subscription_idx').on(t.calendarSubscriptionId, t.receivedAt),
  ]
);

// ── Type exports ───────────────────────────────────────────────────────

export type ApirocWebhookEvent = typeof apirocWebhookEvents.$inferSelect;
export type NewApirocWebhookEvent = typeof apirocWebhookEvents.$inferInsert;
