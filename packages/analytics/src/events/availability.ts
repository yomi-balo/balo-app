// ── Client events (BAL-416) ────────────────────────────────────
export const AVAILABILITY_EVENTS = {
  OVERRIDE_CONFLICT_DETECTED: 'availability_override_conflict_detected',
  OVERRIDE_CONFLICT_RESOLVED: 'availability_override_conflict_resolved',
} as const;

/**
 * ⚠ `'cancelled'` IS NOT A MEMBER AND MUST NOT BE ADDED HERE. BAL-416 ships
 * detect-and-warn ONLY; there is no expert-initiated consultation-cancellation seam
 * (BAL-410 owns building one). Adding the literal before the affordance exists would put a
 * permanently-zero arm in the funnel and imply a capability the platform does not have.
 */
export type AvailabilityConflictResolution = 'blocked_anyway' | 'abandoned';

export interface AvailabilityEventMap {
  [AVAILABILITY_EVENTS.OVERRIDE_CONFLICT_DETECTED]: {
    conflict_count: number;
    /** Inclusive day count of the proposed block (single day = 1). */
    duration_days: number;
    /**
     * ⚠ A PROPERTY, NOT THE IDENTITY. PostHog's client distinct_id is the USER
     * (`analytics.identify(userId, …)`); the BAL-235 server siblings key on
     * `distinct_id = expertProfileId`. Carrying it as a property is what lets the two
     * families join without inventing a second identity for the same human. See plan D9.
     */
    expert_profile_id: string;
  };
  [AVAILABILITY_EVENTS.OVERRIDE_CONFLICT_RESOLVED]: {
    resolution: AvailabilityConflictResolution;
    conflict_count: number;
    expert_profile_id: string;
  };
}

// ── Server events (MOVED from CALENDAR_SERVER_EVENTS by BAL-416) ──
/**
 * ⚠ MOVED, NOT RENAMED. The two BAL-235 events kept their exact wire values
 * (`availability_override_created` / `_deleted`), so PostHog sees no discontinuity — no new
 * person profiles, no reset funnels. They never belonged in `CALENDAR_SERVER_EVENTS`: they
 * are Balo-side scheduling, not calendar-vendor lifecycle, and they were the only members of
 * that constant without a `calendar_` prefix.
 */
export const AVAILABILITY_SERVER_EVENTS = {
  OVERRIDE_CREATED: 'availability_override_created',
  OVERRIDE_DELETED: 'availability_override_deleted',
} as const;

export interface AvailabilityServerEventMap {
  [AVAILABILITY_SERVER_EVENTS.OVERRIDE_CREATED]: {
    /** Inclusive day count of the block (single day = 1). */
    duration_days: number;
    has_label: boolean;
    /** = expertProfileId. */
    distinct_id: string;
  };
  [AVAILABILITY_SERVER_EVENTS.OVERRIDE_DELETED]: {
    /** = expertProfileId. */
    distinct_id: string;
  };
}
