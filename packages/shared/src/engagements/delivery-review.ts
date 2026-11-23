/**
 * Delivery-review window constants (BAL-338 D7, BAL-665, ADR-1060).
 *
 * PURE and dependency-free, so the web, the API and `@balo/db` all read ONE definition. The
 * `delivery_review` reminder sequence derives its step offset from these two values; a second
 * literal anywhere would drift the reminder from the auto-accept the client was promised.
 */

const MS_PER_DAY = 86_400_000;

/**
 * D7 auto-accept window: a `pending_acceptance` project auto-accepts this many days after the
 * completion request. Consumed by the delivery-review sweep (`cutoff = now - AUTO_ACCEPT_DAYS`,
 * passed to `listPendingAutoAccept`, so the repo stays policy-free), the client-facing review
 * copy and the `delivery_review` reminder sequence. Plain typed const, mirroring
 * `QUIET_THRESHOLD_DAYS`.
 *
 * `@balo/db` re-exports this value, so existing web imports of `AUTO_ACCEPT_DAYS` from
 * `@balo/db` keep working; a client component imports it from `@balo/shared/engagements`.
 */
export const AUTO_ACCEPT_DAYS = 7;

/**
 * T-2: the delivery-review reminder is due this many days before auto-accept. This is the
 * auto-accept lead, not the review-nudge bands in `@balo/shared/reviews`.
 */
export const REVIEW_REMINDER_LEAD_DAYS = 2;

/** The promised auto-accept instant for a completion request (requestedAt + the window). */
export function autoAcceptAt(requestedAt: Date): Date {
  return new Date(requestedAt.getTime() + AUTO_ACCEPT_DAYS * MS_PER_DAY);
}

/**
 * The wait the `delivery_review` reminder sequence runs on, or null unless the project is
 * `pending_acceptance` with a completion request. `status` is the folded delivery status. The
 * anchor is the request instant, so a withdrawn-then-re-requested delivery is a new anchor. Both
 * the sweep and the Lookup Follow-ups tab read this rule.
 */
export function deliveryReviewWait(e: {
  status: string;
  completionRequestedAt: Date | null;
}): { anchor: Date; autoAcceptAt: Date } | null {
  if (e.status !== 'pending_acceptance' || e.completionRequestedAt === null) {
    return null;
  }
  return { anchor: e.completionRequestedAt, autoAcceptAt: autoAcceptAt(e.completionRequestedAt) };
}
