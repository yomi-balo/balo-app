export type NotificationChannel = 'email' | 'sms' | 'in-app';

export interface NotificationRule {
  channel: NotificationChannel;
  recipient: 'self' | 'expert' | 'client' | 'admin';
  template: string;
  timing: 'immediate'; // No scheduling yet
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
  'booking.confirmed': [
    {
      channel: 'sms',
      recipient: 'expert',
      template: 'booking-confirmed-sms',
      timing: 'immediate',
      priority: 'critical',
      condition: (ctx) => {
        // ctx.data.user is hydrated by resolveContext via usersRepository.findById()
        // smsOptedIn column does not exist yet — condition evaluates to false (dormant)
        const user = ctx.data.user as { smsOptedIn?: boolean } | undefined;
        return user?.smsOptedIn === true;
      },
    },
  ],
};
