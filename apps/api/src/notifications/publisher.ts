import { getQueue } from '../lib/queue.js';
import type { NotificationEvent, EventPayloadMap } from './events.js';
import { cancelScheduledNotification, scheduleNotification } from './scheduling/schedule.js';

/**
 * BullMQ rejects a custom job id containing `:` — it reserves the colon for its own Redis key
 * namespacing, and `queue.add` throws `Custom Id cannot contain :`.
 *
 * Every credit correlationId is a ledger idempotency key, and `deriveIdempotencyKey` joins its
 * parts with colons (`manual_purchase:{piId}`, `auto_topup:{walletId}:{entryId}`, …). So every
 * credit-domain publish threw at `queue.add` — meaning NO top-up receipt, dunning notice or
 * settlement notification has ever been delivered. It surfaced only as a best-effort
 * `log.error` next to a committed money effect, which is exactly the shape that hides.
 *
 * The substitution is one-to-one (`:` never appears in the remaining segments, which are UUIDs
 * and Stripe ids), so the id stays as unique as the correlationId it is derived from — the
 * dedup guarantee is unchanged, not merely preserved by luck.
 */
export function toJobId(event: string, correlationId: string): string {
  return `${event}--${correlationId}`.replaceAll(':', '_');
}

export const notificationEvents = {
  async publish<E extends NotificationEvent>(event: E, payload: EventPayloadMap[E]): Promise<void> {
    const queue = getQueue('notification-events');
    await queue.add(
      event,
      {
        event,
        payload,
        publishedAt: new Date().toISOString(),
      },
      {
        jobId: toJobId(event, payload.correlationId),
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
      }
    );
  },

  /**
   * BAL-420 — defer a publish. Same import surface as `publish`, so feature code never has
   * to know that "later" is implemented by a Postgres row rather than by the queue.
   * See `scheduling/schedule.ts` for the contract.
   */
  schedule: scheduleNotification,

  /**
   * BAL-420 — void a pending deferred publish. IN-PROCESS ONLY, permanently (ADR-1047
   * Decision 11); returning 0 is normal.
   */
  cancel: cancelScheduledNotification,
};
