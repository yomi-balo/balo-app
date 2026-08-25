import { pgTable, uuid, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * mux_webhook_events (BAL-473) — the event-id idempotency log for the single Mux webhook
 * endpoint (`POST /webhooks/mux`). A DELIBERATE MIRROR of `daily_webhook_events` (BAL-134),
 * which is itself a mirror of `stripe_webhook_events` (BAL-382), down to the column set —
 * so a reviewer who knows one knows all three.
 *
 * ⚠⚠ WHY IT EXISTS, GIVEN THE STATE MACHINE IS ALREADY COMPARE-AND-SET. Every
 * `meetingRecordingsRepository` write is a CAS that a replay loses, so a duplicate delivery
 * of a LIVE event is already harmless. What the CAS does NOT give is the fast, allocation-free
 * SHORT-CIRCUIT (no transaction, no vendor row lookup) on a replayed delivery, nor a durable
 * record that a delivery was seen, nor a serialisation point between two SIMULTANEOUS
 * deliveries of the same event — only the unique index gives that. Mux retries aggressively,
 * so all three matter.
 *
 * APPEND-ONLY: a deliberate exception to the every-table timestamps/soft-delete convention
 * (the `stripe_webhook_events` / `daily_webhook_events` / `credit_ledger` / `audit_events`
 * class) — rows are inserted once and never mutated except the one-shot `processed_at` stamp.
 * Hence NO `...timestamps` / `...softDelete` spread.
 *
 * NO RLS, matching both siblings: an internal idempotency log reached ONLY by the
 * signature-verified webhook through the admin `db` client.
 *
 * ⚠ THE UNIQUE INDEX IS NON-PARTIAL, AND THAT IS SAFE **BECAUSE** THE TABLE IS APPEND-ONLY —
 * the soft-delete + non-partial-unique recreate footgun (memory
 * `reference_softdelete_nonpartial_unique_recreate`) needs a `deleted_at` to bite, and there
 * is none. Non-partial also keeps the `onConflictDoNothing` arbiter total, so the `42P10`
 * partial-arbiter hazard (memory `reference_pg_partial_index_arbiter_param_42p10`) cannot arise.
 */
export const muxWebhookEvents = pgTable(
  'mux_webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Mux's own event id — the natural idempotency key. `text` rather than `uuid`: the
     * format is the VENDOR's to change, and a type that rejected a reformatted id would
     * turn a cosmetic vendor change into a webhook outage.
     */
    eventId: text('event_id').notNull(),
    /** e.g. `video.asset.ready` / `video.asset.errored`. Every other type is recorded and acked. */
    type: text('type').notNull(),
    /**
     * The `meeting_recordings.id` Mux echoed back on `data.passthrough`, when the delivery
     * carries one. NULLABLE — not every Mux event type does, and an asset created outside
     * this pipeline would carry none. ⚠ FOR THE OPS READ ONLY ("what happened to this
     * segment"), never for resolving the row: that is
     * `meetingRecordingsRepository.findById` / `findByMuxAssetId`, which are authoritative.
     * Recorded even when it resolves to nothing, so Mux stops retrying an unactionable body.
     */
    passthrough: text('passthrough'),
    /** Optional integrity check of the raw payload. */
    payloadHash: text('payload_hash'),
    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
    /**
     * Stamped INSIDE the effect transaction, so a persisted `processed_at` always implies a
     * COMMITTED effect. The webhook's replay short-circuit reads exactly this: a marker WITH
     * a stamp means "already applied, do nothing"; a marker WITHOUT one means a prior
     * delivery died mid-flight and the effect is still owed.
     */
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('mux_webhook_events_event_id_idx').on(t.eventId)]
);

// ── Type exports ───────────────────────────────────────────────────────

export type MuxWebhookEvent = typeof muxWebhookEvents.$inferSelect;
export type NewMuxWebhookEvent = typeof muxWebhookEvents.$inferInsert;
