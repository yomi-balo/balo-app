import { eq, sql } from 'drizzle-orm';
import { db } from '../client';
import { dailyWebhookEvents, type DailyWebhookEvent } from '../schema';
import type { DbExecutor } from './_shared/db-executor';

/** One received Daily webhook delivery, before any effect is applied. */
export interface InsertReceivedDailyEventInput {
  /** Daily's event id — the natural idempotency key (unique). */
  eventId: string;
  /** The Daily event type, e.g. `participant.joined`. */
  type: string;
  /** The room the event concerns, when it names one. For the ops read only. */
  roomName?: string | null;
  /** Optional integrity check of the raw payload. */
  payloadHash?: string | null;
}

/**
 * `dailyWebhookEventsRepository` (BAL-134, Decision D2) — the event-id idempotency log for
 * the single Daily webhook. A deliberate mirror of `stripeWebhookEventsRepository` (BAL-382),
 * signature for signature, so the two webhook surfaces read the same way.
 *
 * All methods are tx-composable via `DbExecutor`, and that is the WHOLE POINT rather than a
 * convenience: the marker insert, the presence effect and the `processed_at` stamp must
 * commit or roll back TOGETHER inside the webhook's one `db.transaction`. A marker committed
 * without its effect would permanently suppress the retry that would have applied it — the
 * webhook would answer `200` forever to an event it never acted on. Hence the asymmetry
 * below: the READ defaults to the base `db` (a pre-transaction short-circuit is a legitimate
 * standalone read), while both WRITES demand an executor explicitly, so a caller cannot pass
 * the base client by omission.
 *
 * ⚠ WHAT THIS TABLE DOES NOT DO. It is a REPLAY guard, not an ORDERING guard. Two DISTINCT
 * Daily events arriving out of order (a `participant.left` before its `participant.joined`)
 * carry two distinct event ids and both pass here, correctly — that hazard is bounded by the
 * lifecycle sweep's reconciliation (≤1 tick) and closed by the terminal transitions, per D1's
 * four layers. Do not extend this table to try to solve it.
 */
export const dailyWebhookEventsRepository = {
  /**
   * The marker for a Daily event id, if any. Rides `daily_webhook_events_event_id_idx`.
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
  ): Promise<DailyWebhookEvent | undefined> {
    const [row] = await exec
      .select()
      .from(dailyWebhookEvents)
      .where(eq(dailyWebhookEvents.eventId, eventId))
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
   * effect: the other transaction either already applied it or is about to, and applying it
   * twice is exactly the double-interval over-bill D2 exists to prevent.
   *
   * ⚠ THIS IS THE REAL CONCURRENCY GATE, not `findByEventId`. Two simultaneous deliveries can
   * both pass the pre-transaction read before either commits; only the unique index
   * serialises them. The read is a cheap short-circuit, this is the correctness boundary.
   */
  async insertReceived(
    input: InsertReceivedDailyEventInput,
    exec: DbExecutor
  ): Promise<DailyWebhookEvent | undefined> {
    const [row] = await exec
      .insert(dailyWebhookEvents)
      .values({
        eventId: input.eventId,
        type: input.type,
        roomName: input.roomName ?? null,
        payloadHash: input.payloadHash ?? null,
      })
      .onConflictDoNothing({ target: dailyWebhookEvents.eventId })
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
      .update(dailyWebhookEvents)
      .set({ processedAt: sql`now()` })
      .where(eq(dailyWebhookEvents.eventId, eventId));
  },
};
