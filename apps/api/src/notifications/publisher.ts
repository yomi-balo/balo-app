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
 * WHOSE STORED IDS THIS CHANGES — checked, not assumed. `toJobId` runs on EVERY event, and
 * the `_` → `__` half rewrites the id of any correlationId containing an underscore, whether
 * or not it also contains a colon. That is the same hazard the comment below guards event
 * names against, so it needed verifying rather than waving through.
 *
 * Every production correlationId is one of two shapes: a bare UUID (`randomUUID()`, `z.uuid()`,
 * an entity id) which contains neither character and is untouched; or a colon-joined key, which
 * `queue.add` was already REJECTING outright. There is no production correlationId with an
 * underscore and no colon — so this changes no id that has ever successfully been written.
 *
 * ⚠ That also means the colon defect was never credit-only. 17 production publish sites build
 * colon-joined correlationIds — engagement auto-accept, onboarding reminders, review nudges,
 * wallet dormancy, all nine credit-session notices, meeting availability, booking cancelled,
 * the transcript pipeline. None of them has ever delivered.
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
