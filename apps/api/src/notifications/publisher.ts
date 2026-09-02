import { getQueue } from '../lib/queue.js';
import type { NotificationEvent, EventPayloadMap } from './events.js';
import { cancelScheduledNotification, scheduleNotification } from './scheduling/schedule.js';

/**
 * BullMQ rejects most custom job ids containing `:` (`Custom Id cannot contain :` from
 * `queue.add`) — the precise rule is in THE ACTUAL BULLMQ RULE below; do not paraphrase it
 * from memory, that has gone wrong twice.
 *
 * Credit correlationIds are ledger idempotency keys, which `deriveIdempotencyKey` joins with
 * colons (`manual_purchase:{piId}`, `auto_topup:{walletId}:{entryId}`, …), so the rejected
 * shapes had never delivered a notification — surfacing only as a best-effort `log.error`
 * next to a committed money effect, which is exactly the shape that hides.
 *
 * ⚠ The escape must be INJECTIVE, or two correlationIds collapse onto one job id and BullMQ
 * dedup silently drops a notification — the same silent-loss shape this fix exists to remove.
 *
 * A bare `:` → `_` is not injective: every reason prefix already contains an underscore
 * (`manual_purchase`, `auto_topup`, `overdraft_settlement`), so it is collision-free only by
 * accident of the current prefix set.
 *
 * Escaping `_` → `__` first is ALSO not enough, because the replacement for `:` is then a
 * single `_` that merges with it: `a_:b` and `a:_b` both become `a___b`. "A lone `_` is a `:`,
 * a doubled `__` is a `_`" cannot be decoded on an odd run of three or more.
 *
 * So both escapes are TWO characters and the SECOND one disambiguates: `_` → `__`, `:` → `_c`.
 * Every `_` in the output opens a 2-char sequence, so decoding is unambiguous for any run
 * length — `a_:b` → `a___cb`, `a:_b` → `a_c__b`. This is structural, not a property of the
 * reason names that happen to exist today.
 *
 * THE ACTUAL BULLMQ RULE — read from the installed 5.70.4 source, after two rounds of this
 * comment claiming more than had been checked. `Job.addJob` throws only when
 * `jobId.includes(':') && jobId.split(':').length !== 3` — a carve-out kept for legacy
 * repeatable-job ids. So a jobId with EXACTLY two colons was accepted all along.
 *
 * Consequences, honestly scoped:
 *  · One-colon and three-plus-colon correlationIds (e.g. `manual_purchase:{pi}`,
 *    `overdraft_settlement:{session}`, `{id}:auto_accepted`, the review-nudge and
 *    dormancy-REMINDER ids) threw at `queue.add` — those had never been delivered. (The
 *    dormancy-EXPIRY id, `dormancy_expiry:{wallet}:{date}`, is a two-colon shape: it was
 *    delivering, and belongs to the rewritten set below.)
 *  · EXACTLY-two-colon ids (e.g. `auto_topup:{wallet}:{entry}`,
 *    `{userId}:onboarding_reminder:{step}`) were DELIVERING FINE, and this escape REWRITES
 *    their jobIds. A post-deploy re-publish therefore will not dedup against a retained
 *    pre-deploy job for that set: a bounded, one-time duplicate-notification window at the
 *    deploy boundary — accepted, since the alternative (preserving two-colon ids) would keep
 *    the escape non-injective and the dedup keys dependent on BullMQ's legacy carve-out.
 *  · Bare-UUID correlationIds contain neither character and are untouched.
 *
 * ⚠ Do NOT "optimise" this to escape only when a `:` is present. `a_cb` has no colon and would
 * pass through unchanged, while `a:b` would escape TO `a_cb` — a collision across the two sets.
 * The escape has to be unconditional to stay injective.
 */
export function toJobId(event: string, correlationId: string): string {
  // Escape ONLY the correlationId. Event names are a fixed enum that never contains `:`, and
  // rewriting them would change the job id of notifications that already work — breaking
  // their dedup against retained completed jobs and re-sending on the next retry.
  const safeCorrelationId = correlationId.replaceAll('_', '__').replaceAll(':', '_c');
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
