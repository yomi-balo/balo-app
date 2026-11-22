// -- Server events (fire from API/workers via trackServer) ----------------------------
export const NOTIFICATION_SERVER_EVENTS = {
  SMS_SENT: 'notification_sms_sent',
  SMS_FAILED: 'notification_sms_failed',
  SMS_SKIPPED: 'notification_sms_skipped',
  IN_APP_SENT: 'notification_in_app_sent',
  IN_APP_FAILED: 'notification_in_app_failed',
} as const;

export interface NotificationServerEventMap {
  [NOTIFICATION_SERVER_EVENTS.SMS_SENT]: {
    template: string;
    recipient_phone_masked: string;
    distinct_id: string;
  };
  [NOTIFICATION_SERVER_EVENTS.SMS_FAILED]: {
    template: string;
    error_type: string;
    distinct_id: string;
  };
  [NOTIFICATION_SERVER_EVENTS.SMS_SKIPPED]: {
    template: string;
    skip_reason: string;
    distinct_id: string;
  };
  [NOTIFICATION_SERVER_EVENTS.IN_APP_SENT]: {
    template: string;
    event: string;
    distinct_id: string;
  };
  [NOTIFICATION_SERVER_EVENTS.IN_APP_FAILED]: {
    template: string;
    event: string;
    error_type: string;
    distinct_id: string;
  };
}

// -- Client events (fire from the notification bell via track) ------------------------
export const NOTIFICATION_EVENTS = {
  TOAST_SHOWN: 'notification_toast_shown',
  TOAST_DISMISSED: 'notification_toast_dismissed',
  PANEL_OPENED: 'notification_panel_opened',
  CLICKED: 'notification_clicked',
  AUTO_READ: 'notification_auto_read',
} as const;

export interface NotificationEventMap {
  [NOTIFICATION_EVENTS.TOAST_SHOWN]:
    | { count: number; trigger: 'load' }
    | {
        count: number;
        trigger: 'live';
        transport: 'push' | 'poll' | 'catch_up';
        latency_ms: number;
      };
  [NOTIFICATION_EVENTS.TOAST_DISMISSED]: {
    count: number;
    reason: 'close' | 'timeout';
  };
  [NOTIFICATION_EVENTS.PANEL_OPENED]: {
    unread_count: number;
    source: 'bell' | 'toast';
  };
  [NOTIFICATION_EVENTS.CLICKED]: {
    event: string;
    source: 'panel' | 'toast';
  };
  [NOTIFICATION_EVENTS.AUTO_READ]: {
    count: number;
  };
}

/**
 * `reminder_sent` fires when the promise is handed to the notification engine, not on delivery;
 * delivery is tracked by each channel's own events.
 */
export const REMINDER_SERVER_EVENTS = {
  SENT: 'reminder_sent',
  SKIPPED: 'reminder_skipped',
} as const;

export interface ReminderServerEventMap {
  [REMINDER_SERVER_EVENTS.SENT]: {
    sequence: string;
    step: string;
    channel: 'email' | 'sms' | 'in_app';
    audience: 'client' | 'expert';
    distinct_id: string;
  };
  [REMINDER_SERVER_EVENTS.SKIPPED]: {
    sequence: string;
    step: string;
    reason: string;
    distinct_id: string;
  };
}
