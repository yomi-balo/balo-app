export type NotificationChannel = 'email' | 'sms' | 'in-app' | 'push';

export interface NotificationRule {
  channel: NotificationChannel;
  recipient: 'self' | 'expert' | 'client' | 'admin';
  template: string;
  timing: 'immediate'; // No scheduling for BAL-175
  condition?: (context: RuleContext) => boolean;
  priority?: 'normal' | 'critical';
}

export interface RuleContext {
  event: string;
  payload: Record<string, unknown>;
  data: Record<string, unknown>;
}

export const notificationRules: Record<string, NotificationRule[]> = {
  'user.welcome': [
    {
      channel: 'email',
      recipient: 'self',
      template: 'welcome',
      timing: 'immediate',
      priority: 'critical',
    },
  ],
  'expert.application_submitted': [
    {
      channel: 'email',
      recipient: 'self',
      template: 'application-submitted',
      timing: 'immediate',
      priority: 'critical',
    },
  ],
};
