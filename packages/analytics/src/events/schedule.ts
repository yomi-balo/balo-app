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
    /** True when any enabled range crosses midnight (end earlier than start) — BAL-415. */
    has_overnight_window: boolean;
    /** True when any enabled range ends after 22:00 WITHOUT crossing midnight. */
    has_late_window: boolean;
  };
  [SCHEDULE_EVENTS.BOOKING_RULES_SAVED]: {
    expert_id: string;
    /** Minutes of buffer reserved before each consultation. */
    buffer_before_minutes: number;
    /** Minutes of buffer reserved after each consultation. */
    buffer_after_minutes: number;
    /** Soonest a client can book, in minutes from now. */
    minimum_notice_minutes: number;
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
