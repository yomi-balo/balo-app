/**
 * BAL-236 — a NEW client family, deliberately not an extension of `CALENDAR_EVENTS`:
 * `CALENDAR_SERVER_EVENTS` already owns the unprefixed wire names
 * `availability_override_created` / `availability_override_deleted` (`./calendar.ts`) and must
 * not be shadowed (D11).
 */
export const AVAILABILITY_EVENTS = {
  CALENDAR_VIEWED: 'availability_calendar_viewed',
  SLOT_SELECTED: 'availability_slot_selected',
  DURATION_FILTER_USED: 'availability_duration_filter_used',
  EMPTY_STATE_SHOWN: 'availability_empty_state_shown',
} as const;

export interface AvailabilityEventMap {
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
