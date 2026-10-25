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
  [NOTIFICATION_EVENTS.TOAST_SHOWN]: {
    count: number;
    trigger: 'load' | 'live';
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
