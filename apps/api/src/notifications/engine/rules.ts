export type NotificationChannel = 'email' | 'sms' | 'in-app';

export interface NotificationRule {
  channel: NotificationChannel;
  recipient: 'self' | 'expert' | 'client' | 'admin' | 'non_selected_experts' | 'admin_users';
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
  // BAL-272: the client asked this expert for a formal proposal — a commit
  // moment, so it is email-worthy (unlike per-message chatter, in-app only).
  'project.proposal_requested': [
    {
      channel: 'email',
      recipient: 'expert',
      template: 'project-proposal-requested',
      timing: 'immediate',
      priority: 'normal',
    },
    {
      channel: 'in-app',
      recipient: 'expert',
      template: 'project-proposal-requested',
      timing: 'immediate',
    },
  ],
  // BAL-288: the expert submitted a formal proposal — a commit moment the client
  // is waiting on, so email-worthy (plus in-app). recipient:'client' resolves via
  // payload.recipientId (the request owner's user id).
  'project.proposal_submitted': [
    {
      channel: 'email',
      recipient: 'client',
      template: 'project-proposal-submitted',
      timing: 'immediate',
      priority: 'normal',
    },
    {
      channel: 'in-app',
      recipient: 'client',
      template: 'project-proposal-submitted',
      timing: 'immediate',
    },
  ],
  // BAL-289: the client accepted an expert's proposal — a decision that fans out
  // to THREE audiences in one event. The WINNING expert (recipient:'expert',
  // resolved from the hydrated data.expert) gets a congratulatory in-app + email;
  // the NON-SELECTED experts (recipient:'non_selected_experts', fan-out over
  // data.nonSelectedExpertUserIds) get a gracious in-app + email; and the ADMINS
  // (recipient:'admin_users', fan-out over data.adminUserIds) get an in-app "raise
  // invoice" ops nudge. The two fan-out recipients are resolved to id[] by the
  // dispatcher's additive fan-out branch (one delivery row per recipient).
  'project.proposal_accepted': [
    {
      channel: 'in-app',
      recipient: 'expert',
      template: 'project-proposal-accepted',
      timing: 'immediate',
    },
    {
      channel: 'email',
      recipient: 'expert',
      template: 'project-proposal-accepted',
      timing: 'immediate',
      priority: 'normal',
    },
    {
      channel: 'in-app',
      recipient: 'non_selected_experts',
      template: 'project-proposal-not-selected',
      timing: 'immediate',
    },
    {
      channel: 'email',
      recipient: 'non_selected_experts',
      template: 'project-proposal-not-selected',
      timing: 'immediate',
      priority: 'normal',
    },
    {
      channel: 'in-app',
      recipient: 'admin_users',
      template: 'project-proposal-accepted-admin',
      timing: 'immediate',
    },
  ],
  // BAL-290 (A6.4): the client requested changes on a submitted proposal — a commit
  // moment the expert must act on, so email-worthy (plus in-app). recipient:'expert'
  // resolves from the hydrated data.expert (resolver maps payload.expertProfileId →
  // user id), exactly like project.proposal_accepted's winning-expert path.
  'project.changes_requested': [
    {
      channel: 'email',
      recipient: 'expert',
      template: 'project-changes-requested',
      timing: 'immediate',
      priority: 'normal',
    },
    {
      channel: 'in-app',
      recipient: 'expert',
      template: 'project-changes-requested',
      timing: 'immediate',
    },
  ],
  // BAL-290 (A6.4): the expert resubmitted an updated proposal (v(n+1)) — the client
  // is waiting on it, so email-worthy (plus in-app). recipient:'client' resolves via
  // payload.recipientId (the request owner's user id), like project.proposal_submitted.
  'project.proposal_resubmitted': [
    {
      channel: 'email',
      recipient: 'client',
      template: 'project-proposal-resubmitted',
      timing: 'immediate',
      priority: 'normal',
    },
    {
      channel: 'in-app',
      recipient: 'client',
      template: 'project-proposal-resubmitted',
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
