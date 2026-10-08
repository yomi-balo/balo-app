import type { ExpertDeclineReason, ExpertApplicationEditSection } from '@balo/shared/experts';

/**
 * BAL-549 — the admin expert-applications surface's CLIENT event family (throughput and wait
 * times for the application funnel). Both events are browser-emitted; there is no server family.
 *
 * ⚠ AN `admin_`-PREFIXED FAMILY, NOT `EXPERT_EVENTS` (orchestrator D6). `EXPERT_EVENTS` is the
 * APPLICANT-SIDE wizard family and already carries thirteen `expert_application_*` constants; a
 * Balo-staff decision event does not belong there even though it would have been the cheaper
 * change. This matches the three shipped staff families (ADMIN_LOOKUP_EVENTS,
 * ADMIN_ENGAGEMENTS_EVENTS, ADMIN_ALERTS_EVENTS), whose prefix-pinning guards REQUIRED the
 * rename from the ticket's literal `expert_application_reviewed` /
 * `expert_application_list_viewed`.
 */
export const ADMIN_APPLICATIONS_EVENTS = {
  REVIEWED: 'admin_applications_reviewed',
  LIST_VIEWED: 'admin_applications_list_viewed',
  /** BAL-593 — a staff save that changed something on the application (a `no_changes` plan
   *  result never emits this). */
  EDITED: 'admin_applications_edited',
} as const;

/**
 * The decision that was recorded. ⚠ `'declined'`, not `'rejected'` — the STORED
 * `application_status` label is `'rejected'` but every surface, including this funnel metric,
 * says "declined" (orchestrator D2).
 */
export type AdminApplicationDecision = 'approved' | 'declined';

export interface AdminApplicationsEventMap {
  [ADMIN_APPLICATIONS_EVENTS.REVIEWED]: {
    decision: AdminApplicationDecision;
    /**
     * Whole days from `expert_profiles.submitted_at` — the TRUE wait
     * (`applicationWaitingDays`, `@balo/shared/experts`). ⚠ NOT the queue row's age, which is
     * `admin_alerts.first_seen_at`-derived and lags by at least 2h (orchestrator O7).
     */
    days_waiting: number;
    /** The decline CATEGORY. Absent on an approve; NEVER the staff-only note. */
    reason?: ExpertDeclineReason;
  };
  [ADMIN_APPLICATIONS_EVENTS.LIST_VIEWED]: {
    pending_count: number;
    /** `days_waiting` of the OLDEST pending application, or 0 when none are pending. */
    oldest_days: number;
  };
  /**
   * BAL-593 — a staff save that changed something. `status` collapses `submitted` and
   * `under_review` into `'pending'` (the same fold the review page's own badge already uses);
   * `'approved'` is reported as-is. `sections` lists which of the four edit sections changed, in
   * `EXPERT_APPLICATION_EDIT_SECTIONS` order. The five snake_case counts mirror
   * `StaffApplicationEditCounts` (`@balo/shared/experts`) field-for-field.
   */
  [ADMIN_APPLICATIONS_EVENTS.EDITED]: {
    status: 'pending' | 'approved';
    sections: ExpertApplicationEditSection[];
    ratings_adjusted: number;
    products_added: number;
    products_removed: number;
    certifications_added: number;
    certifications_removed: number;
  };
}
