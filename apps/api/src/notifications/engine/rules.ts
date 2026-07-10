export type NotificationChannel = 'email' | 'sms' | 'in-app';

export interface NotificationRule {
  channel: NotificationChannel;
  recipient:
    | 'self'
    | 'expert'
    | 'client'
    | 'admin'
    | 'non_selected_experts'
    | 'admin_users'
    | 'email_address'
    | 'billing_creator'
    | 'party_admins'
    | 'owner';
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

/** The common email + in-app rule pair for a single recipient/template. */
function emailAndInApp(
  recipient: NotificationRule['recipient'],
  template: string,
  condition?: NotificationRule['condition']
): NotificationRule[] {
  return [
    {
      channel: 'email',
      recipient,
      template,
      timing: 'immediate',
      priority: 'normal',
      ...(condition ? { condition } : {}),
    },
    {
      channel: 'in-app',
      recipient,
      template,
      timing: 'immediate',
      ...(condition ? { condition } : {}),
    },
  ];
}

/** Creator FYI fires only when the creator differs from the owner (recipientId). */
const creatorIsDistinctMember: NonNullable<NotificationRule['condition']> = (ctx) =>
  typeof ctx.payload.creatorUserId === 'string' &&
  ctx.payload.creatorUserId !== ctx.payload.recipientId;

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
  // BAL-325: referral invite to an EXTERNAL email (not a Balo user). The
  // 'email_address' recipient reads the address straight from the event payload in
  // the dispatcher — there is no user row to hydrate. Email channel only (no in-app
  // for a non-user).
  'expert.referral_invited': [
    {
      channel: 'email',
      recipient: 'email_address',
      template: 'expert-referral-invited',
      timing: 'immediate',
      priority: 'normal',
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
    // BAL-315: client heads-up when an ADMIN requested a proposal on the client's
    // behalf. In-app only (email is a deferred follow-up). Gated on `initiatedBy`
    // so the client's OWN request (`initiatedBy: 'client'`) never self-notifies.
    // recipient:'client' resolves via payload.recipientId (the request owner).
    {
      channel: 'in-app',
      recipient: 'client',
      template: 'project-proposal-requested-client',
      timing: 'immediate',
      condition: (ctx) => ctx.payload.initiatedBy === 'admin',
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
  // BAL-291: the client approved kickoff — the engagement is live. Notifies BOTH
  // sides (email + in-app each): the delivering expert (recipient:'expert', resolved
  // from the hydrated data.expert via payload.expertProfileId) gets a "time to deliver"
  // nudge; the approving client (recipient:'client', resolved via payload.recipientId)
  // gets a "your expert is ready" confirmation.
  'project.kickoff_approved': [
    ...emailAndInApp('expert', 'project-kickoff-approved-expert'),
    ...emailAndInApp('client', 'project-kickoff-approved-client'),
  ],
  // BAL-290 (A6.4): the client requested changes on a submitted proposal — a commit
  // moment the expert must act on, so email-worthy (plus in-app). recipient:'expert'
  // resolves from the hydrated data.expert (resolver maps payload.expertProfileId →
  // user id), exactly like project.proposal_accepted's winning-expert path.
  'project.changes_requested': emailAndInApp('expert', 'project-changes-requested'),
  // BAL-290 (A6.4): the expert resubmitted an updated proposal (v(n+1)) — the client
  // is waiting on it, so email-worthy (plus in-app). recipient:'client' resolves via
  // payload.recipientId (the request owner's user id), like project.proposal_submitted.
  'project.proposal_resubmitted': emailAndInApp('client', 'project-proposal-resubmitted'),
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
  // BAL-324: admin billing reminder. One event, two audiences. The OWNER
  // (recipient:'client' → payload.recipientId) always gets email + in-app with
  // the "complete billing" CTA. The request CREATOR (recipient:'billing_creator'
  // → payload.creatorUserId) gets an email + in-app FYI ONLY when the action set
  // `creatorUserId` (creator ≠ owner AND a company member) — the condition guards
  // the resolver too, so a self-notify can never slip through.
  'project.billing_reminder': [
    ...emailAndInApp('client', 'project-billing-reminder-owner'),
    ...emailAndInApp(
      'billing_creator',
      'project-billing-reminder-creator',
      creatorIsDistinctMember
    ),
  ],
  // BAL-323: the client captured their company's billing details (first-time only —
  // the publisher never emits this on an edit or the repeat-company auto-skip). The
  // admins (fanned out over data.adminUserIds) get an in-app "ready to invoice"
  // nudge — IN-APP ONLY (not time-sensitive; no email, no SMS).
  'billing.details_confirmed': [
    {
      channel: 'in-app',
      recipient: 'admin_users',
      template: 'billing-details-confirmed-admin',
      timing: 'immediate',
    },
  ],
  // BAL-332 (D2): the delivering expert marked a milestone complete. Fans out to the
  // CLIENT company owner (recipient:'client' via payload.recipientId; email + in-app —
  // a delivery moment the client reviews against) and the Balo ADMINS
  // (recipient:'admin_users' fan-out over data.adminUserIds; in-app ops signal). The
  // owner rules skip gracefully when recipientId is absent (retainer / no-owner).
  'engagement.milestone_completed': [
    ...emailAndInApp('client', 'engagement-milestone-completed-client'),
    {
      channel: 'in-app',
      recipient: 'admin_users',
      template: 'engagement-milestone-completed-admin',
      timing: 'immediate',
    },
  ],
  // BAL-332 (D2): the expert reopened a completed milestone. IN-APP ONLY to BOTH the
  // client owner and the admins — reverts are never silent, but they aren't
  // email-worthy. One template shared by both rules.
  'engagement.milestone_reverted': [
    {
      channel: 'in-app',
      recipient: 'client',
      template: 'engagement-milestone-reverted',
      timing: 'immediate',
    },
    {
      channel: 'in-app',
      recipient: 'admin_users',
      template: 'engagement-milestone-reverted',
      timing: 'immediate',
    },
  ],
  // BAL-333 (D3): the delivering expert changed the delivery plan (add / material edit
  // / remove). CLIENT owner (recipient:'client' via payload.recipientId; email + in-app
  // — the client is TOLD, not asked; the price is unchanged, stated in copy) + Balo
  // ADMINS (recipient:'admin_users' fan-out over data.adminUserIds; in-app ops signal).
  // Owner rules skip gracefully when recipientId is absent (retainer / no-owner). No SMS.
  'engagement.scope_changed': [
    ...emailAndInApp('client', 'engagement-scope-changed-client'),
    {
      channel: 'in-app',
      recipient: 'admin_users',
      template: 'engagement-scope-changed-admin',
      timing: 'immediate',
    },
  ],
  // BAL-334 (D4): the delivering expert marked the WHOLE project complete — it now
  // sits under the client's review. The CLIENT company owner (recipient:'client' via
  // payload.recipientId; email = VARIANT 1 CompletionRequestEmail + in-app) is ASKED
  // to review; the Balo ADMINS (recipient:'admin_users' fan-out; in-app ops signal)
  // are told it's under review. Owner rules skip gracefully when recipientId is absent.
  'engagement.completion_requested': [
    ...emailAndInApp('client', 'engagement-completion-requested-client'),
    {
      channel: 'in-app',
      recipient: 'admin_users',
      template: 'engagement-completion-requested-admin',
      timing: 'immediate',
    },
  ],
  // BAL-334 (D4): the expert withdrew the completion request — the project is active
  // again. IN-APP ONLY to BOTH the client owner and the admins (never silent, not
  // email-worthy). One template shared by both rules.
  'engagement.completion_withdrawn': [
    {
      channel: 'in-app',
      recipient: 'client',
      template: 'engagement-completion-withdrawn',
      timing: 'immediate',
    },
    {
      channel: 'in-app',
      recipient: 'admin_users',
      template: 'engagement-completion-withdrawn',
      timing: 'immediate',
    },
  ],
  // BAL-334 (D4): Balo cancelled the engagement. Notifies BOTH parties (email + in-app
  // each): the CLIENT company owner (recipient:'client' via payload.recipientId) and
  // the delivering EXPERT (recipient:'expert' via payload.expertProfileId → data.expert).
  // No admin recipient — the admin is the actor. One template serves both rules.
  'engagement.cancelled': [
    ...emailAndInApp('client', 'engagement-cancelled'),
    ...emailAndInApp('expert', 'engagement-cancelled'),
  ],
  // BAL-338 (D7): the client ACCEPTED the project (explicit). Fans out to the
  // delivering EXPERT (recipient:'expert' via payload.expertProfileId → data.expert;
  // email + in-app — congratulations, Balo handles the final invoice) and the Balo
  // ADMINS (recipient:'admin_users' fan-out; email + in-app — THE MONEY TRIGGER,
  // "Ready to invoice: final installment"). No client recipient (they just acted).
  'engagement.accepted': [
    ...emailAndInApp('expert', 'engagement-accepted-expert'),
    ...emailAndInApp('admin_users', 'engagement-accepted-admin'),
  ],
  // BAL-338 (D7): the client requested changes instead of accepting — the project is
  // active again. The delivering EXPERT (recipient:'expert'; email + in-app — the
  // client's note verbatim + "the review window restarts when you re-request") must
  // act; the Balo ADMINS (recipient:'admin_users' fan-out; IN-APP ONLY) get an ops
  // signal.
  'engagement.changes_requested': [
    ...emailAndInApp('expert', 'engagement-changes-requested-expert'),
    {
      channel: 'in-app',
      recipient: 'admin_users',
      template: 'engagement-changes-requested-admin',
      timing: 'immediate',
    },
  ],
  // BAL-338 (D7): the review window elapsed with no client decision — the D7 sweep
  // auto-accepted (server-published). Fans out to the CLIENT company owner
  // (recipient:'client' via payload.recipientId; email = VARIANT 3 AutoAcceptedEmail
  // verbatim + in-app), the delivering EXPERT (recipient:'expert'; email + in-app), and
  // the Balo ADMINS (recipient:'admin_users' fan-out; email + in-app — the money
  // trigger). Client rules skip gracefully when recipientId is absent (retainer/no-owner).
  'engagement.auto_accepted': [
    ...emailAndInApp('client', 'engagement-auto-accepted-client'),
    ...emailAndInApp('expert', 'engagement-auto-accepted-expert'),
    ...emailAndInApp('admin_users', 'engagement-auto-accepted-admin'),
  ],
  // BAL-338 (D7): T-2 review reminder (server-published). Targets the CLIENT company
  // owner only (recipient:'client' via payload.recipientId; email = VARIANT 2
  // ReviewReminderEmail verbatim + in-app). Skips gracefully when recipientId is absent.
  'engagement.review_reminder': emailAndInApp('client', 'engagement-review-reminder-client'),
  // BAL-345 domain auto-join. `party_admins` is a fan-out recipient (one delivery
  // per admin) resolved from data.partyAdminUserIds; `self` (approve/decline)
  // resolves to payload.userId (the requester). The base-member joiner/requester
  // is naturally excluded from the admin fan-out (they lack MANAGE_MEMBERS).
  //
  // member_joined: admins-only FYI, IN-APP ONLY (not email-worthy — an auto-join
  // is low-signal). request_created: admins must act → email + in-app.
  // approved/declined: the requester is waiting → email + in-app.
  'party.member_joined_via_domain': [
    {
      channel: 'in-app',
      recipient: 'party_admins',
      template: 'party-member-joined-via-domain',
      timing: 'immediate',
    },
  ],
  'party.join_request_created': emailAndInApp('party_admins', 'party-join-request-created'),
  'party.join_request_approved': emailAndInApp('self', 'party-join-request-approved'),
  'party.join_request_declined': emailAndInApp('self', 'party-join-request-declined'),
  // BAL-348: a corporate expert provisioned a new agency. The new OWNER
  // (recipient:'owner' → payload.ownerUserId; a single recipient, NOT a fan-out) gets
  // an email + in-app milestone notice naming the team. Corporate-only gating lives at
  // the emit site — SOLO / JOIN / already_linked never publish this event.
  'agency.provisioned': emailAndInApp('owner', 'agency-provisioned'),
};
