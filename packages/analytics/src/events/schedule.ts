export const SCHEDULE_EVENTS = {
  SAVED: 'schedule_saved',
  BOOKING_RULES_SAVED: 'booking_rules_saved',
  TIMEZONE_CHANGED: 'schedule_timezone_changed',
  CLEARED: 'schedule_cleared',
  TIMEZONE_MISMATCH_SHOWN: 'schedule_timezone_mismatch_shown',
  TIMEZONE_MISMATCH_RESOLVED: 'schedule_timezone_mismatch_resolved',
} as const;

/** How the mismatch dialog was reached: raised by device detection, or by a manual zone pick. */
export type TimezoneMismatchSource = 'detected' | 'manual';

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
    /** Who started the change, not which UI finished it. `settings`: begun in the Schedule tab's
     *  zone picker, whether it committed straight away or through that tab's manual confirm
     *  dialog. `mismatch_dialog`: a Switch in the prompt raised by the device-zone mismatch gate. */
    source: 'settings' | 'mismatch_dialog';
  };
  [SCHEDULE_EVENTS.CLEARED]: {
    expert_id: string;
  };
  [SCHEDULE_EVENTS.TIMEZONE_MISMATCH_SHOWN]: {
    expert_id: string;
    /** The zone the saved hours are read in. */
    from_timezone: string;
    /** The zone the hours would be re-read in. */
    to_timezone: string;
    source: TimezoneMismatchSource;
  };
  [SCHEDULE_EVENTS.TIMEZONE_MISMATCH_RESOLVED]: {
    expert_id: string;
    from_timezone: string;
    to_timezone: string;
    source: TimezoneMismatchSource;
    action: 'kept' | 'switched';
    /** True when the dialog was dismissed with Escape (always `action: 'kept'`). */
    via_escape: boolean;
    /** Upcoming consultations the switch would put outside the hours; `null` while the check
     *  was still running or failed. */
    affected_consultations: number | null;
  };
}
