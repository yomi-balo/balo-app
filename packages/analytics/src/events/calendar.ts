export const CALENDAR_EVENTS = {
  CONNECT_INITIATED: 'calendar_connect_initiated',
  DISCONNECT_INITIATED: 'calendar_disconnect_initiated',
  SUB_CALENDAR_TOGGLED: 'calendar_sub_calendar_toggled',
  TARGET_CALENDAR_SET: 'calendar_target_calendar_set',
} as const;

export interface CalendarEventMap {
  [CALENDAR_EVENTS.CONNECT_INITIATED]: {
    provider: 'google' | 'microsoft';
  };
  [CALENDAR_EVENTS.DISCONNECT_INITIATED]: {
    provider: 'google' | 'microsoft';
  };
  [CALENDAR_EVENTS.SUB_CALENDAR_TOGGLED]: {
    sub_calendar_id: string;
    conflict_checking: boolean;
    provider: 'google' | 'microsoft';
  };
  [CALENDAR_EVENTS.TARGET_CALENDAR_SET]: {
    target_calendar_id: string;
    provider: 'google' | 'microsoft';
  };
}
