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

// ── Server-side events ──────────────────────────────────────────

export const CALENDAR_SERVER_EVENTS = {
  OAUTH_COMPLETED: 'calendar_oauth_completed',
  OAUTH_FAILED: 'calendar_oauth_failed',
  DISCONNECTED: 'calendar_disconnected',
  TOKEN_REFRESHED: 'calendar_token_refreshed',
  WEBHOOK_RECEIVED: 'calendar_webhook_received',
  AVAILABILITY_CACHE_REBUILT: 'calendar_availability_cache_rebuilt',
} as const;

export interface CalendarServerEventMap {
  [CALENDAR_SERVER_EVENTS.OAUTH_COMPLETED]: {
    provider: string;
    status: 'connected' | 'sync_pending';
    distinct_id: string;
  };
  [CALENDAR_SERVER_EVENTS.OAUTH_FAILED]: {
    error_message: string;
    distinct_id: string;
  };
  [CALENDAR_SERVER_EVENTS.DISCONNECTED]: {
    distinct_id: string;
  };
  [CALENDAR_SERVER_EVENTS.TOKEN_REFRESHED]: {
    distinct_id: string;
  };
  [CALENDAR_SERVER_EVENTS.WEBHOOK_RECEIVED]: {
    notification_type: string;
    distinct_id: string;
  };
  [CALENDAR_SERVER_EVENTS.AVAILABILITY_CACHE_REBUILT]: {
    distinct_id: string;
  };
}
