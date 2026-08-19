import { eq, sql } from 'drizzle-orm';
import { db } from '../client';
import { apirocWebhookEvents, type ApirocWebhookEvent } from '../schema';
import type { DbExecutor } from './_shared/db-executor';

/** One received Apiroc calendar-change delivery, before its effect is applied. */
export interface InsertReceivedApirocEventInput {
  /** Svix's message id from the `svix-id` header — the natural idempotency key (unique). */
  svixId: string;
  /** The live `calendar_subscriptions` row the delivery resolved to. */
  calendarSubscriptionId: string;
  /** The Apiroc event type as delivered, e.g. `calendar.event.changed`. */
  eventType: string;
}

/**
 * `apirocWebhookEventsRepository` (BAL-468) — the `svix-id` idempotency log for the inbound
 * Apiroc calendar-change webhook. A deliberate mirror of `dailyWebhookEventsRepository`
 * (BAL-134, D2), signature for signature, so the three webhook surfaces read the same way.
 *
 * ⚠⚠ BRANCH ON `processedAt`, NOT ON ROW PRESENCE. A row whose `processed_at` is NULL is a
 * delivery that was received and then DIED before its effect landed — the retry exists to
 * repair exactly that. A caller that treated any row as "already handled" would answer 2xx
 * forever to a calendar change it never rebuilt availability for, and the expert's slot
 * picker would stay stale until the 15-minute staleness cron happened to catch it.
 *
 * ⚠ THIS HANDLER DOES NOT WRAP ITS WRITES IN ONE TRANSACTION, and that is a departure from
 * the Daily handler that is deliberate rather than an oversight: the effect here is a BullMQ
 * enqueue, which is not transactional with Postgres, so a `db.transaction` around it would
 * buy the appearance of atomicity and none of the substance. The `exec` parameter is kept
 * EXPLICIT on both writes anyway — it preserves the house signature and makes the
 * base-client choice visible at the call site rather than accidental, and it means this
 * repository composes correctly on the day the handler grows an effect that IS transactional.
 *
 * ⚠ REPLAY GUARD, NOT AN ORDERING GUARD. Two DISTINCT changes on one calendar carry two
 * distinct `svix-id`s and both pass here, correctly — the rebuild is idempotent and coalesced
 * on `availability-${expertProfileId}`, which is what makes that safe. Do not extend this
 * table to try to order deliveries.
 */
export const apirocWebhookEventsRepository = {
  /**
   * The marker for a `svix-id`, if any. Rides `apiroc_webhook_events_svix_id_idx`.
   *
   * Defaults to the base `db` so the handler's pre-effect replay check is a plain read; pass
   * an executor to see a marker inserted earlier in the SAME transaction.
   *
   * ⚠ See the ⚠⚠ above: presence is not "handled" — `processedAt` is.
   */
  async findBySvixId(
    svixId: string,
    exec: DbExecutor = db
  ): Promise<ApirocWebhookEvent | undefined> {
    const [row] = await exec
      .select()
      .from(apirocWebhookEvents)
      .where(eq(apirocWebhookEvents.svixId, svixId))
      .limit(1);
    return row;
  },

  /**
   * Insert the received marker. `onConflictDoNothing` on the NON-PARTIAL unique `svix_id` — so
   * no arbiter predicate is needed and the 42P10 partial-arbiter hazard (memory
   * `reference_pg_partial_index_arbiter_param_42p10`) does not arise here at all. That
   * non-partiality is safe precisely because the table is append-only and has no `deleted_at`
   * (see the schema docblock).
   *
   * Returns the inserted row on FIRST sight and `undefined` when the id was already recorded
   * — a concurrent or replayed delivery.
   *
   * ⚠ THIS IS THE REAL CONCURRENCY GATE, not `findBySvixId`. Two simultaneous deliveries can
   * both pass the pre-read before either commits; only the unique index serialises them. The
   * read is a cheap short-circuit; this is the correctness boundary.
   */
  async insertReceived(
    input: InsertReceivedApirocEventInput,
    exec: DbExecutor
  ): Promise<ApirocWebhookEvent | undefined> {
    const [row] = await exec
      .insert(apirocWebhookEvents)
      .values({
        svixId: input.svixId,
        calendarSubscriptionId: input.calendarSubscriptionId,
        eventType: input.eventType,
      })
      .onConflictDoNothing({ target: apirocWebhookEvents.svixId })
      .returning();
    return row;
  },

  /**
   * Stamp `processed_at = now()` for a delivery, once its effect has landed. Uses the DB
   * `now()` so the value is TRANSACTION time rather than whenever the Node process happened
   * to construct a `Date`.
   *
   * A no-op for an unknown id (updates zero rows, never throws): the caller has already
   * learned everything it needs from `insertReceived`, and turning a lost race into an
   * exception here would fail a webhook that behaved correctly — and, worse, hand Svix a
   * non-2xx that puts a correctly-processed delivery back in the retry queue.
   */
  async markProcessed(svixId: string, exec: DbExecutor): Promise<void> {
    await exec
      .update(apirocWebhookEvents)
      .set({ processedAt: sql`now()` })
      .where(eq(apirocWebhookEvents.svixId, svixId));
  },
};
