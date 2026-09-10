/**
 * BAL-548 / ADR-1055 — the admin pending-actions queue's CLIENT event family.
 *
 * A NEW FILE, not an addition to `admin-engagements.ts`: that file's key set is pinned by test,
 * and the precedent (`settings.ts`, `command-palette.ts`) is a new file per family rather than
 * folding an unrelated feature's events into an existing one.
 *
 * All three events are CLIENT-side (`track()` from `@/lib/analytics`). No server events — the
 * sweep's observability is its own structured logs, not PostHog. `analytics.identify()` /
 * `reset()` are not applicable here; this feature establishes and destroys no session.
 */

/**
 * Coarse waiting-time buckets. The queue measures WAITING, and a raw day count is
 * PII-adjacent noise (it can pin an exact alert to an exact PostHog session over time).
 * Boundaries mirror `ADMIN_ALERT_AGE_EMPHASIS_DAYS`'s own `>=` convention: a boundary value
 * rolls into the NEXT bucket up, never the one below (`adminAlertAgeBucket` in
 * `apps/web`'s `_lib/admin-queue-view.ts` is the one place this is computed).
 */
export type AdminAlertAgeBucket = 'under_1d' | '1_3d' | '3_7d' | 'over_7d';

/** The four tile filters, plus the unfiltered default. Mirrors `AdminAlertTileGroup` plus
 *  `'all'` — kept as its own literal union here (not imported from `@balo/shared/admin-alerts`)
 *  so this package's client event family carries no `@balo/db`-adjacent dependency. */
export type AdminAlertQueueFilter = 'all' | 'marketplace' | 'money' | 'capture' | 'meetings';

export const ADMIN_ALERTS_EVENTS = {
  /** The Home queue was viewed — on load and on a filter change. `AdminQueueAnalytics`
   *  (apps/web) is the ONE dispatch point. */
  QUEUE_VIEWED: 'admin_queue_viewed',
  /** A row's "Open {target}" deep link was clicked. `AlertRow` (apps/web) is the ONE dispatch
   *  point. */
  ALERT_OPENED: 'admin_alert_opened',
  /** A no-finder-kind row was closed with a note, and the Server Action returned success.
   *  `AlertRow` (apps/web) is the ONE dispatch point — never the Server Action itself (BAL-548's
   *  analytics are client-side only). */
  ALERT_CLOSED: 'admin_alert_closed',
} as const;

export interface AdminAlertsEventMap {
  [ADMIN_ALERTS_EVENTS.QUEUE_VIEWED]: {
    open_count: number;
    oldest_age_days: number;
    filter: AdminAlertQueueFilter;
  };
  [ADMIN_ALERTS_EVENTS.ALERT_OPENED]: { kind: string; age_bucket: AdminAlertAgeBucket };
  [ADMIN_ALERTS_EVENTS.ALERT_CLOSED]: { kind: string; age_bucket: AdminAlertAgeBucket };
}
