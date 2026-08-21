/**
 * Availability events — client and server.
 *
 * ⚠ TWO FAMILIES CONVERGED HERE INDEPENDENTLY, and the union is deliberate. BAL-416 created
 * this file for the time-off conflict warnings and MOVED the two BAL-235 server events out of
 * `CALENDAR_SERVER_EVENTS`; BAL-236 concurrently created the same `AVAILABILITY_EVENTS` family
 * for the slot picker. Both landed on the same reasoning — availability is Balo-side scheduling,
 * not calendar-vendor lifecycle — so the members are unioned rather than one being folded into
 * `CALENDAR_EVENTS`. No key or wire value is shared between the two sets.
 */

// ── Client events (BAL-416 conflict warnings + BAL-236 slot picker) ──
export const AVAILABILITY_EVENTS = {
  // BAL-416 — warn before blocking time off over confirmed sessions.
  OVERRIDE_CONFLICT_DETECTED: 'availability_override_conflict_detected',
  OVERRIDE_CONFLICT_RESOLVED: 'availability_override_conflict_resolved',
  // BAL-236 — the ExpertAvailabilityCalendar slot picker.
  CALENDAR_VIEWED: 'availability_calendar_viewed',
  SLOT_SELECTED: 'availability_slot_selected',
  DURATION_FILTER_USED: 'availability_duration_filter_used',
  EMPTY_STATE_SHOWN: 'availability_empty_state_shown',
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
  /**
   * ⚠ The four BAL-236 picker events carry `expert_id` (also `expert_profiles.id`) rather than
   * the `expert_profile_id` the BAL-416 pair uses — the two families were authored in parallel
   * against their own tickets' stated payloads. Same value, two property names in one family;
   * worth converging on `expert_profile_id` in a follow-up, but renaming a shipped wire property
   * is a PostHog-continuity decision, not a merge-conflict resolution.
   */
  [AVAILABILITY_EVENTS.CALENDAR_VIEWED]: {
    /** `expert_profiles.id`. */
    expert_id: string;
    mode: 'preview' | 'selectable';
    viewer_type: 'expert' | 'client';
  };
  [AVAILABILITY_EVENTS.SLOT_SELECTED]: {
    expert_id: string;
    slot_start_utc: string;
    duration_minutes: number;
    viewer_timezone: string;
  };
  [AVAILABILITY_EVENTS.DURATION_FILTER_USED]: {
    expert_id: string;
    filter_value: number | 'any';
  };
  [AVAILABILITY_EVENTS.EMPTY_STATE_SHOWN]: {
    expert_id: string;
    reason: 'not_configured' | 'no_slots' | 'unavailable' | 'no_slots_for_filter';
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
