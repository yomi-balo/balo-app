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
  'expert.approved': [
    {
      channel: 'email',
      recipient: 'self',
      template: 'expert-approved',
      timing: 'immediate',
      priority: 'critical',
    },
  ],
  'project.request_submitted': [
    {
      channel: 'email',
      recipient: 'expert',
      template: 'project-request-submitted',
      timing: 'immediate',
      priority: 'normal',
    },
  ],
  'project.match_requested': [
    {
      channel: 'email',
      recipient: 'admin',
      template: 'project-match-requested',
      timing: 'immediate',
      priority: 'normal',
    },
  ],
  'project.exploratory_requested': [
    {
      channel: 'email',
      recipient: 'client',
      template: 'project-exploratory-requested',
      timing: 'immediate',
      priority: 'normal',
    },
    {
      channel: 'in-app',
      recipient: 'client',
      template: 'project-exploratory-requested',
      timing: 'immediate',
    },
  ],
  'project.expert_invited': [
    {
      channel: 'email',
      recipient: 'expert',
      template: 'project-expert-invited',
      timing: 'immediate',
      priority: 'normal',
    },
    {
      channel: 'in-app',
      recipient: 'expert',
      template: 'project-expert-invited',
      timing: 'immediate',
    },
  ],
  'project.eoi_submitted': [
    {
      channel: 'email',
      recipient: 'client',
      template: 'project-eoi-submitted',
      timing: 'immediate',
      priority: 'normal',
    },
    {
      channel: 'in-app',
      recipient: 'client',
      template: 'project-eoi-submitted',
      timing: 'immediate',
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
        const user = ctx.data.user as { phoneVerifiedAt?: string | Date } | undefined;
        return !!user?.phoneVerifiedAt;
      },
    },
    {
      channel: 'in-app',
      recipient: 'expert',
      template: 'booking-confirmed',
      timing: 'immediate',
    },
  ],
  'message.received': [
    {
      channel: 'in-app',
      recipient: 'client',
      template: 'new-message',
      timing: 'immediate',
    },
  ],
  // BAL-271 conversation events: IN-APP ONLY (per-message email = spam; a
  // digest is a future engine feature). One event, two conditioned rules —
  // the payload's recipientRole routes to exactly one of them.
  'project.message_posted': [
    {
      channel: 'in-app',
      recipient: 'client',
      template: 'project-message-posted',
      timing: 'immediate',
      condition: (ctx) => ctx.payload.recipientRole === 'client',
    },
    {
      channel: 'in-app',
      recipient: 'expert',
      template: 'project-message-posted',
      timing: 'immediate',
      condition: (ctx) => ctx.payload.recipientRole === 'expert',
    },
  ],
  'project.file_shared': [
    {
      channel: 'in-app',
      recipient: 'client',
      template: 'project-file-shared',
      timing: 'immediate',
      condition: (ctx) => ctx.payload.recipientRole === 'client',
    },
    {
      channel: 'in-app',
      recipient: 'expert',
      template: 'project-file-shared',
      timing: 'immediate',
      condition: (ctx) => ctx.payload.recipientRole === 'expert',
    },
  ],
};
