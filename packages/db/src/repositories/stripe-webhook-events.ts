import { eq, sql } from 'drizzle-orm';
import { db } from '../client';
import { stripeWebhookEvents, type StripeWebhookEvent } from '../schema';
import type { DbExecutor } from './_shared/db-executor';

/**
 * `stripeWebhookEventsRepository` (BAL-382) — the event-id idempotency log for the single
 * Stripe webhook. All methods are tx-composable via `DbExecutor` (mirrors
 * `auditEventsRepository.record(input, exec)`), so the marker insert + effect + processed
 * stamp commit or roll back together inside the webhook's `db.transaction`.
 */
export const stripeWebhookEventsRepository = {
  /**
   * The event marker for a Stripe event id, if any. Read — defaults to the base `db`;
   * pass the webhook `tx` to read a marker inserted earlier in the same transaction.
   * Rides `stripe_webhook_events_event_id_idx`.
   */
  async findByEventId(
    eventId: string,
    exec: DbExecutor = db
  ): Promise<StripeWebhookEvent | undefined> {
    const [row] = await exec
      .select()
      .from(stripeWebhookEvents)
      .where(eq(stripeWebhookEvents.eventId, eventId))
      .limit(1);
    return row;
  },

  /**
   * Insert the received marker for an event. `onConflictDoNothing` on the unique
   * `event_id` — returns the inserted row on first sight and `undefined` when the event
   * id was already recorded (a concurrent / replayed delivery), so the caller can decide
   * whether the prior delivery already finished. Pass the webhook `tx`.
   */
  async insertReceived(
    input: { eventId: string; type: string; payloadHash?: string | null },
    exec: DbExecutor
  ): Promise<StripeWebhookEvent | undefined> {
    const [row] = await exec
      .insert(stripeWebhookEvents)
      .values({
        eventId: input.eventId,
        type: input.type,
        payloadHash: input.payloadHash ?? null,
      })
      .onConflictDoNothing({ target: stripeWebhookEvents.eventId })
      .returning();
    return row;
  },

  /**
   * Stamp `processed_at = now()` for an event — called atomically with the effect so a
   * persisted `processed_at` always implies a committed effect. Uses the DB `now()` so
   * the timestamp is the transaction time. Pass the webhook `tx`.
   */
  async markProcessed(eventId: string, exec: DbExecutor): Promise<void> {
    await exec
      .update(stripeWebhookEvents)
      .set({ processedAt: sql`now()` })
      .where(eq(stripeWebhookEvents.eventId, eventId));
  },
};
