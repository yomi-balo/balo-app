// -- Server events (fire from API/workers via trackServer) ----------------------------
export const NOTIFICATION_SERVER_EVENTS = {
  SMS_SENT: 'notification_sms_sent',
  SMS_FAILED: 'notification_sms_failed',
  SMS_SKIPPED: 'notification_sms_skipped',
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
}
