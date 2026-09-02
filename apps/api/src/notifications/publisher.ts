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
 * ⚠ The escape must be INJECTIVE, or two correlationIds collapse onto one job id and BullMQ
 * dedup silently drops a notification — the same silent-loss shape this fix exists to remove.
 * A bare `:` → `_` is NOT injective: every reason prefix already contains an underscore
 * (`manual_purchase`, `auto_topup`, `overdraft_settlement`), so it is only collision-free by
 * accident of the current prefix set. Adding a reason named `manual` or `auto` later would
 * silently merge ids. Escaping `_` first makes it structural: a lone `_` decodes to `:`, a
 * doubled `__` to `_`, so distinct inputs stay distinct for ANY future reason name.
 *
 * No stored ids are invalidated by this: every credit publish had been throwing, so none was
 * ever written.
 */
export function toJobId(event: string, correlationId: string): string {
  // Escape ONLY the correlationId. Event names are a fixed enum that never contains `:`, and
  // rewriting them would change the job id of notifications that already work — breaking
  // their dedup against retained completed jobs and re-sending on the next retry.
  const safeCorrelationId = correlationId.replaceAll('_', '__').replaceAll(':', '_');
  return `${event}--${safeCorrelationId}`;
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
