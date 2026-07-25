export const SCHEDULE_EVENTS = {
  SAVED: 'schedule_saved',
  BOOKING_RULES_SAVED: 'booking_rules_saved',
  TIMEZONE_CHANGED: 'schedule_timezone_changed',
  CLEARED: 'schedule_cleared',
} as const;

export interface ScheduleEventMap {
  [SCHEDULE_EVENTS.SAVED]: {
    expert_id: string;
    /** Number of days with at least one enabled range. */
    days_enabled: number;
    /** True when any enabled day has more than one range (split day). */
    has_split_days: boolean;
  };
  [SCHEDULE_EVENTS.BOOKING_RULES_SAVED]: {
    expert_id: string;
  };
  [SCHEDULE_EVENTS.TIMEZONE_CHANGED]: {
    expert_id: string;
    from_timezone: string;
    to_timezone: string;
  };
  [SCHEDULE_EVENTS.CLEARED]: {
    expert_id: string;
  };
}
