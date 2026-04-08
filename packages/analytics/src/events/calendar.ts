export const CALENDAR_EVENTS = {
  CONNECT_INITIATED: 'calendar_connect_initiated',
  DISCONNECT_INITIATED: 'calendar_disconnect_initiated',
  SUB_CALENDAR_TOGGLED: 'calendar_sub_calendar_toggled',
  TARGET_CALENDAR_SET: 'calendar_target_calendar_set',
  // BAL-233: Error state events
  FIX_PERMISSIONS_CLICKED: 'calendar_fix_permissions_clicked',
  RECONNECT_CLICKED: 'calendar_reconnect_clicked',
  SYNC_PENDING_RESOLVED: 'calendar_sync_pending_resolved',
  O365_GUIDANCE_SHOWN: 'calendar_o365_guidance_shown',
  O365_GUIDANCE_CONTINUED: 'calendar_o365_guidance_continued',
  O365_GUIDANCE_CANCELLED: 'calendar_o365_guidance_cancelled',
  O365_WAITING_TRY_AGAIN: 'calendar_o365_waiting_try_again',
  SESSION_EXPIRED_TRY_AGAIN: 'calendar_session_expired_try_again',
  CONNECTING_TIMEOUT: 'calendar_connecting_timeout',
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
  [CALENDAR_EVENTS.FIX_PERMISSIONS_CLICKED]: {
    provider: 'google' | 'microsoft';
  };
  [CALENDAR_EVENTS.RECONNECT_CLICKED]: {
    provider: 'google' | 'microsoft';
  };
  [CALENDAR_EVENTS.SYNC_PENDING_RESOLVED]: {
    provider: 'google' | 'microsoft';
  };
  [CALENDAR_EVENTS.O365_GUIDANCE_SHOWN]: Record<string, never>;
  [CALENDAR_EVENTS.O365_GUIDANCE_CONTINUED]: Record<string, never>;
  [CALENDAR_EVENTS.O365_GUIDANCE_CANCELLED]: Record<string, never>;
  [CALENDAR_EVENTS.O365_WAITING_TRY_AGAIN]: Record<string, never>;
  [CALENDAR_EVENTS.SESSION_EXPIRED_TRY_AGAIN]: {
    provider: 'google' | 'microsoft';
  };
  [CALENDAR_EVENTS.CONNECTING_TIMEOUT]: {
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
  // BAL-233: Error state events
  RELINK_URL_GENERATED: 'calendar_relink_url_generated',
  SYNC_PENDING_AUTO_RESOLVED: 'calendar_sync_pending_auto_resolved',
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
  [CALENDAR_SERVER_EVENTS.RELINK_URL_GENERATED]: {
    distinct_id: string;
  };
  [CALENDAR_SERVER_EVENTS.SYNC_PENDING_AUTO_RESOLVED]: {
    distinct_id: string;
  };
}
