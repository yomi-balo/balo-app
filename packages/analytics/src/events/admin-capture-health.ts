/**
 * BAL-550 — the `/admin/health/capture` lens's CLIENT event family.
 *
 * A NEW FILE, not an addition to `admin-alerts.ts`: that file's key set is pinned by test, and
 * the precedent (`admin-alerts.ts` itself, `settings.ts`, `command-palette.ts`) is a new file
 * per family rather than folding an unrelated feature's events into an existing one.
 *
 * Both events are CLIENT-side (`track()` from `@/lib/analytics`). No server events — this
 * feature publishes no domain event of its own (the re-drive re-enters BAL-387's pipeline,
 * which does its own `recap.ready` publish). `analytics.identify()` / `reset()` are not
 * applicable here; this feature establishes and destroys no session.
 *
 * ⚠ `filter` and `kind` are kept as their OWN literal unions here (not imported from
 * `@balo/shared/capture-health`), mirroring `admin-alerts.ts`'s `AdminAlertQueueFilter` — so
 * this package's client event family carries no `@balo/db`-adjacent dependency.
 */

/** The four tile filters, plus the unfiltered default. Mirrors `CaptureHealthCategory` plus
 *  `'all'`. */
export type CaptureHealthQueueFilter = 'all' | 'recording' | 'transcription' | 'recap' | 'healthy';

/** The two re-drivable kinds. Mirrors `RedriveKind`. */
export type AdminRedriveKind = 'recording-ingest' | 'transcript-pipeline';

/** The confirm sheet's settled outcome, coarsened for analytics. */
export type AdminRedriveOutcome = 'queued' | 'refused' | 'forbidden' | 'failed';

export const ADMIN_CAPTURE_HEALTH_EVENTS = {
  /** The capture-health lens was viewed — on load and on a filter/window change.
   *  `CaptureHealthAnalytics` (apps/web) is the ONE dispatch point. */
  VIEWED: 'admin_capture_health_viewed',
  /** A re-drive confirm sheet was confirmed and the request settled (queued or refused).
   *  `RedriveSheet` (apps/web) is the ONE dispatch point. */
  REDRIVE_REQUESTED: 'admin_redrive_requested',
} as const;

export interface AdminCaptureHealthEventMap {
  [ADMIN_CAPTURE_HEALTH_EVENTS.VIEWED]: {
    window_days: number;
    filter: CaptureHealthQueueFilter;
    issue_count: number;
  };
  [ADMIN_CAPTURE_HEALTH_EVENTS.REDRIVE_REQUESTED]: {
    kind: AdminRedriveKind;
    outcome: AdminRedriveOutcome;
  };
}
