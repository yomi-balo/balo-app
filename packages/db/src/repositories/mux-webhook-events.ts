import { eq, sql } from 'drizzle-orm';
import { db } from '../client';
import { muxWebhookEvents, type MuxWebhookEvent } from '../schema';
import type { DbExecutor } from './_shared/db-executor';

/** One received Mux webhook delivery, before any effect is applied. */
export interface InsertReceivedMuxEventInput {
  /** Mux's event id — the natural idempotency key (unique). */
  eventId: string;
  /** The Mux event type, e.g. `video.asset.ready`. */
  type: string;
  /**
   * The `meeting_recordings.id` echoed back on `data.passthrough`, when the delivery carries
   * one. For the ops read only — never for resolving the row.
   */
  passthrough?: string | null;
  /** Optional integrity check of the raw payload. */
  payloadHash?: string | null;
}

/**
 * `muxWebhookEventsRepository` (BAL-473) — the event-id idempotency log for the single Mux
 * webhook. A deliberate mirror of `dailyWebhookEventsRepository` (BAL-134), which is itself a
 * mirror of `stripeWebhookEventsRepository` (BAL-382) — signature for signature, so all three
 * webhook surfaces read the same way. The only difference is the context column:
 * `passthrough` here, `room_name` there.
 *
 * All methods are tx-composable via `DbExecutor`, and that is the WHOLE POINT rather than a
 * convenience: the marker insert, the recording effect and the `processed_at` stamp must
 * commit or roll back TOGETHER inside the webhook's one `db.transaction`. A marker committed
 * without its effect would permanently suppress the retry that would have applied it — the
 * webhook would answer `200` forever to an event it never acted on. Hence the asymmetry
 * below: the READ defaults to the base `db` (a pre-transaction short-circuit is a legitimate
 * standalone read), while both WRITES demand an executor explicitly, so a caller cannot pass
 * the base client by omission.
 *
 * ⚠ WHY THIS EXISTS AT ALL, GIVEN EVERY `meetingRecordingsRepository` WRITE IS ALREADY A
 * COMPARE-AND-SET. This is the thing to understand before deleting it as redundant. A CAS
 * already makes a duplicate delivery of a LIVE event harmless — the replay updates zero rows.
 * What a CAS does NOT give is (1) the fast, allocation-free SHORT-CIRCUIT on a replay, before
 * any transaction is opened or any vendor row is looked up; (2) a durable record that a
 * delivery was SEEN at all, including for a type with no effect; or (3) a serialisation point
 * between two SIMULTANEOUS deliveries of the same event, which only the unique index provides.
 * Mux retries aggressively, so all three matter.
 *
 * ⚠ WHAT THIS TABLE DOES NOT DO. It is a REPLAY guard, not an ORDERING guard. Two DISTINCT
 * Mux events arriving out of order carry two distinct event ids and both pass here, correctly
 * — that hazard is bounded by the state machine's CAS predicates, which refuse a transition
 * from the wrong source state. Do not extend this table to try to solve it.
 */
export const muxWebhookEventsRepository = {
  /**
   * The marker for a Mux event id, if any. Rides `mux_webhook_events_event_id_idx`.
   *
   * Defaults to the base `db` so the webhook's PRE-transaction replay check is a plain read;
   * pass the webhook `tx` to see a marker inserted earlier in the SAME transaction.
   *
   * ⚠ THE CALLER MUST BRANCH ON `processedAt`, NOT ON PRESENCE. A row whose `processed_at` is
   * NULL is a delivery that was received and then DIED before committing its effect (or, more
   * usually, one whose transaction rolled back and took the marker with it — in which case
   * there is no row at all). Treating any row as "already handled" would silently drop the
   * effect of the retry that exists to repair it.
   */
  async findByEventId(
    eventId: string,
    exec: DbExecutor = db
  ): Promise<MuxWebhookEvent | undefined> {
    const [row] = await exec
      .select()
      .from(muxWebhookEvents)
      .where(eq(muxWebhookEvents.eventId, eventId))
      .limit(1);
    return row;
  },

  /**
   * Insert the received marker for an event. `onConflictDoNothing` on the NON-PARTIAL unique
   * `event_id` — so no arbiter predicate is needed and the `42P10` partial-arbiter hazard
   * (memory `reference_pg_partial_index_arbiter_param_42p10`) does not arise here at all.
   *
   * Returns the inserted row on FIRST sight and `undefined` when the id was already recorded
   * — a concurrent or replayed delivery. `undefined` is the caller's signal to abandon the
   * effect: the other transaction either already applied it or is about to.
   *
   * ⚠ THIS IS THE REAL CONCURRENCY GATE, not `findByEventId`. Two simultaneous deliveries can
   * both pass the pre-transaction read before either commits; only the unique index
   * serialises them. The read is a cheap short-circuit, this is the correctness boundary.
   *
   * ⚠ THE MARKER IS WRITTEN EVEN WHEN `passthrough` RESOLVES TO NOTHING. An asset created
   * outside this pipeline, or a type we do not handle, still gets a marker and a `200` — so
   * Mux stops retrying a body that will never be actionable.
   */
  async insertReceived(
    input: InsertReceivedMuxEventInput,
    exec: DbExecutor
  ): Promise<MuxWebhookEvent | undefined> {
    const [row] = await exec
      .insert(muxWebhookEvents)
      .values({
        eventId: input.eventId,
        type: input.type,
        passthrough: input.passthrough ?? null,
        payloadHash: input.payloadHash ?? null,
      })
      .onConflictDoNothing({ target: muxWebhookEvents.eventId })
      .returning();
    return row;
  },

  /**
   * Stamp `processed_at = now()` for an event — called on the SAME executor as the effect, so
   * a persisted stamp always implies a committed effect. Uses the DB `now()` so the value is
   * the TRANSACTION time rather than whenever the Node process happened to construct a `Date`.
   *
   * A no-op for an unknown id (updates zero rows, never throws): the caller has already
   * learned everything it needs from `insertReceived`, and turning a lost race into an
   * exception here would fail a webhook that behaved correctly.
   */
  async markProcessed(eventId: string, exec: DbExecutor): Promise<void> {
    await exec
      .update(muxWebhookEvents)
      .set({ processedAt: sql`now()` })
      .where(eq(muxWebhookEvents.eventId, eventId));
  },
};
