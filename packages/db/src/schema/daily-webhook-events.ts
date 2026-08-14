import { pgTable, uuid, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * daily_webhook_events (BAL-134, Decision D2) — the event-id idempotency log for the single
 * Daily webhook endpoint (`POST /webhooks/daily`). A DELIBERATE MIRROR of
 * `stripe_webhook_events` (BAL-382), down to the column set, so a reviewer who knows one
 * knows this one.
 *
 * ⚠⚠ WHY IT EXISTS AT ALL, GIVEN THE PRESENCE PRIMITIVES ARE ALREADY IDEMPOTENT. This is the
 * one thing to understand before deleting it as redundant. `meetingPresenceRepository.open()`
 * is `ON CONFLICT DO NOTHING` on a partial unique over OPEN intervals, and `close()` is a
 * first-close-wins compare-and-set. Between them they survive a duplicate delivery of a LIVE
 * event completely. What they do NOT survive is a **`participant.joined` REPLAYED AFTER ITS
 * INTERVAL HAS LEGITIMATELY CLOSED**: the unique index constrains only `left_at IS NULL` rows,
 * so the replay conflicts with nothing and inserts a SECOND interval anchored at the OLD
 * `joined_at` with no `left_at` — an open interval in the past. `computeMeetingClocks`
 * measures an open interval to whatever instant the clock is read at, so that is a silent,
 * unbounded OVER-BILL on a money path, produced by a transport-layer retry.
 *
 * A `text` `event_id` marker closes it for EVERY event type at once, in the transport layer
 * where the problem lives. The rejected alternative was a "does a closed interval already
 * cover this instant" predicate inside `open()` — which mutates a shipped, test-pinned money
 * primitive to solve a webhook-delivery problem, in the wrong layer.
 *
 * APPEND-ONLY: a deliberate exception to the every-table timestamps/soft-delete convention
 * (the same class as `stripe_webhook_events`, `credit_ledger` and `audit_events`) — rows are
 * inserted once and never mutated except the one-shot `processed_at` stamp, and are never
 * soft-deleted. Hence NO `...timestamps` / `...softDelete` spread.
 *
 * NO RLS, matching `stripe_webhook_events` and the whole meetings family (`meetings`,
 * `meeting_contexts`, `meeting_presence`) — this table is an internal idempotency log reached
 * ONLY by the signature-verified webhook through the admin `db` client. A user never queries
 * it, and the admin client bypasses RLS anyway, so a policy here would be both inconsistent
 * with its siblings and inert.
 *
 * ⚠ THE UNIQUE INDEX IS NON-PARTIAL, AND THAT IS SAFE **BECAUSE** THE TABLE IS APPEND-ONLY.
 * The soft-delete + non-partial-unique recreate footgun (memory
 * `reference_softdelete_nonpartial_unique_recreate`) needs a soft-delete to bite: a row that
 * is stamped `deleted_at` but keeps occupying its unique key blocks the re-create. There is no
 * `deleted_at` here and no writer that could add one, so a partial predicate would guard
 * against a state that cannot exist — and would COST correctness, since the arbiter would then
 * be partial and every `onConflictDoNothing` on it would have to restate the predicate with
 * inlined literals or fail `42P10` (memory `reference_pg_partial_index_arbiter_param_42p10`).
 * Non-partial is both the simpler and the stricter choice here.
 */
export const dailyWebhookEvents = pgTable(
  'daily_webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Daily's own event id — the natural idempotency key, and the ONLY thing that makes a
     * replay distinguishable from a genuine second event. Kept `text` rather than uuid: the
     * id is a VENDOR string whose format is Daily's to change, and a type that rejects a
     * reformatted id would turn a cosmetic vendor change into a webhook outage.
     */
    eventId: text('event_id').notNull(),
    /** The Daily event type, e.g. `participant.joined` / `participant.left` / `meeting.ended`. */
    type: text('type').notNull(),
    /**
     * The Daily room the event concerns, when it names one. NULLABLE because not every event
     * type does — this column is for the OPS READ ("what happened to this room"), never for
     * resolving the meeting: that is `meetingsRepository.findByDailyRoomName`, which is
     * authoritative and rides `meeting_daily_room_name_idx`. Recorded even when the room
     * resolves to no meeting (a soft-deleted or unknown room still gets a marker + a `200`,
     * so Daily stops retrying a body that will never be actionable).
     */
    roomName: text('room_name'),
    /** Optional integrity check of the raw payload. */
    payloadHash: text('payload_hash'),
    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
    /**
     * Stamped INSIDE the effect transaction, so a persisted `processed_at` always implies a
     * COMMITTED effect. The webhook's replay short-circuit reads exactly this: a marker with
     * `processed_at` set means "already applied, do nothing"; a marker WITHOUT one means a
     * prior delivery died mid-flight and the effect is still owed.
     */
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('daily_webhook_events_event_id_idx').on(t.eventId)]
);

// ── Type exports ───────────────────────────────────────────────────────

export type DailyWebhookEvent = typeof dailyWebhookEvents.$inferSelect;
export type NewDailyWebhookEvent = typeof dailyWebhookEvents.$inferInsert;
