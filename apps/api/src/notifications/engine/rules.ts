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
    | 'company_billing_admins'
    | 'owner'
    // BAL-408 — the live participants of ONE SIDE of a meeting. None of the shipped kinds
    // expressed "the same-party members of this meeting": `party_admins` is admin-only and
    // party-scoped, `client`/`expert` are single recipients. The id list is resolved by the
    // PUBLISHER (`payload.recipientUserIds`), never by the resolver — that is what keeps a
    // `meeting_guests` read out of the notification engine.
    | 'meeting_party_participants';
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

/** SMS gate: the recipient has a verified phone (mirrors `booking-confirmed-sms`). */
const recipientPhoneVerified: NonNullable<NotificationRule['condition']> = (ctx) => {
  const user = ctx.data.user as { phoneVerifiedAt?: string | Date } | undefined;
  return !!user?.phoneVerifiedAt;
};

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
  // BAL-386: a client member shared a submitted proposal with an EXTERNAL colleague.
  // The 'email_address' recipient reads the address straight from the event payload
  // in the dispatcher — there is no user row to hydrate. Email channel ONLY, external
  // recipient, NO expert notification (mirrors expert.referral_invited).
  'proposal.shared': [
    {
      channel: 'email',
      recipient: 'email_address',
      template: 'proposal-shared',
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
  // BAL-271 conversation events (BAL-424 renamed them off the `project.` prefix — the
  // anchor is now the ADR-1045 §2 seam, so the same event fires for a Case with no
  // project). BOTH STAY IN-APP ONLY AND IMMEDIATE: a per-message email is spam. The EMAIL is
  // the separate, DEBOUNCED `conversation.unread_digest_due` below, scheduled +10 minutes by
  // the worker's follow-up hook. One event, two conditioned rules — the payload's
  // recipientRole routes to exactly one of them.
  //
  // ⚠⚠ EACH OF THESE TWO EVENTS MUST KEEP AT LEAST ONE RULE. `processNotificationEvent`
  // RETURNS EARLY on an event with no rules, and the follow-up hook that schedules the
  // digest runs AFTER that lookup — so emptying either array would silently disable the
  // unread email for that half of the exchange.
  'conversation.message_posted': [
    {
      channel: 'in-app',
      recipient: 'client',
      template: 'conversation-message-posted',
      timing: 'immediate',
      condition: (ctx) => ctx.payload.recipientRole === 'client',
    },
    {
      channel: 'in-app',
      recipient: 'expert',
      template: 'conversation-message-posted',
      timing: 'immediate',
      condition: (ctx) => ctx.payload.recipientRole === 'expert',
    },
  ],
  'conversation.file_shared': [
    {
      channel: 'in-app',
      recipient: 'client',
      template: 'conversation-file-shared',
      timing: 'immediate',
      condition: (ctx) => ctx.payload.recipientRole === 'client',
    },
    {
      channel: 'in-app',
      recipient: 'expert',
      template: 'conversation-file-shared',
      timing: 'immediate',
      condition: (ctx) => ctx.payload.recipientRole === 'expert',
    },
  ],
  /**
   * BAL-424 — the 10-minute debounced unread digest. EMAIL ONLY (the in-app notice already
   * fired immediately, above), routed by `recipientRole` exactly like the two events that
   * schedule it.
   *
   * ⚠ ONE PROMISE COVERS MESSAGES **AND** FILE SHARES. Both publishers call the same
   * scheduler on the same dedupe key
   * `conversation-unread:{conversationId}:{recipientUserId}`, so a message at T+0 and a file
   * at T+3min fold into ONE email.
   *
   * ⚠ IT IS GUARDED. `conversation_unread` re-reads live state at fire time and skips when
   * the recipient's `conversation_read_states` watermark has passed every unread message AND
   * file — the dedupe key is NOT a rate limit (ADR-1047 Decision 5).
   *
   * ⚠ BOTH ARMS RESOLVE `recipient: 'self'`, UNLIKE THE TWO IMMEDIATE EVENTS ABOVE. Those
   * split `client` / `expert` because the two sides resolve their user id from DIFFERENT
   * payload fields (`recipientId` vs a hydrated `expertProfileId`). Here the recipient was
   * ALREADY resolved to a user id at SCHEDULE time and stored as `recipientUserId` — the
   * recheck needs a user id to read the watermark by — so both arms name the same field. The
   * pair is kept, conditioned on `recipientRole`, so exactly one rule fires per publish and
   * the two sides can diverge in copy or priority later without restructuring the event.
   */
  'conversation.unread_digest_due': [
    {
      channel: 'email',
      recipient: 'self',
      template: 'conversation-unread-digest',
      timing: 'immediate',
      priority: 'normal',
      condition: (ctx) => ctx.payload.recipientRole === 'client',
    },
    {
      channel: 'email',
      recipient: 'self',
      template: 'conversation-unread-digest',
      timing: 'immediate',
      priority: 'normal',
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
  // "Ready to invoice: final installment").
  //
  // BAL-390: the ACCEPTING client now also gets a fused acceptance-confirmation +
  // rating ask, recipient:'self' via payload.userId — MIRRORING payment.charged, where
  // the acting member gets their own personal receipt (credit.topup.completed and
  // promo.redeemed do the same). Acceptance is the trigger for the final invoice, so
  // the client should hold written evidence of it without logging in. This DELIBERATELY
  // OVERTURNS this rule's former "No client recipient (they just acted)" comment — that
  // was the outlier, not the pattern. EMAIL ONLY: they just clicked accept, so an in-app
  // "you accepted" is noise. Gated on payload.userId so an older publisher (or a
  // retainer/no-actor path) skips rather than sending a half-populated email. This is
  // the client's FIRST AND ONLY email at this moment, so D7's "one email, never two"
  // holds.
  'engagement.accepted': [
    ...emailAndInApp('expert', 'engagement-accepted-expert'),
    ...emailAndInApp('admin_users', 'engagement-accepted-admin'),
    {
      channel: 'email',
      recipient: 'self',
      template: 'engagement-accepted-client',
      timing: 'immediate',
      priority: 'normal',
      condition: (ctx) => typeof ctx.payload.userId === 'string',
    },
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
  // BAL-390 (D4): a CASE was closed — ONE fused email: close confirmation → case
  // summary → the star-rating ask. Targets the client-side reviewer (recipient:'client'
  // via payload.recipientId; email + in-app), conditioned on recipientId so a
  // no-reviewer close skips rather than dead-lettering. NO admin fan-out — the client
  // is the sole target, exactly like engagement.review_reminder.
  //
  // ⚠ LIVE AS OF BAL-388: `resolveCaseAction` (the recap's client-side close) is the FIRST
  // and today ONLY publisher, so this rule delivers a real email to a real client. The
  // `auto_inactive` arm is still unpublished — BAL-420's sweep owns it — and it reuses this
  // same rule and template with a different `closeReason`.
  'engagement.case_closed': emailAndInApp(
    'client',
    'engagement-case-closed-client',
    (ctx) => typeof ctx.payload.recipientId === 'string'
  ),
  // BAL-390: the star-rating nudge at +24h / +7d off the terminal anchor
  // (server-published by the hourly review-nudge sweep). EMAIL ONLY to the reviewer
  // (recipient:'self' via payload.userId — the onboarding.reminder shape): the ask IS
  // the in-email star row, and an in-app copy would carry neither stars nor token.
  // One event covers both cadence steps; the step lives in the payload, not the rule.
  //
  // ⚠ NOT `engagement.review_reminder` above — that is BAL-338's pre-auto-accept
  // "review the delivered work" nudge. Different meaning, payload and template.
  'review.reminder': [
    {
      channel: 'email',
      recipient: 'self',
      template: 'review-nudge',
      timing: 'immediate',
      priority: 'normal',
    },
  ],
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
  // BAL-396 §7 (Objection 5) — `calendar.auth_error` already existed and already fired; it had
  // no rule, so `engine/worker.ts`'s `log.warn('No notification rules found for event')` was
  // its only effect. This is the missing rule, not a new event. `recipient: 'expert'` resolves
  // via `payload.expertProfileId` (resolver.ts) — the connection's own expert, email + in-app.
  'calendar.auth_error': emailAndInApp('expert', 'calendar-reconnect-required'),
  // BAL-468 — the daily calendar-subscription monitor's non-zero-arm alert. IN-APP ONLY,
  // matching `billing.details_confirmed`'s shape: this is an ops signal for Balo staff, not a
  // time-critical email — the `log.error('apiroc_subscription_expiry_alert')` in the sweep
  // itself is the real paging channel. `recipient: 'admin_users'` (NOT `'admin'`, which
  // resolves to the single `OPS_NOTIFICATION_EMAIL` literal and silently skips the send when
  // that var is unset). Server-only (published by the sweep).
  'calendar.subscription_lapse': [
    {
      channel: 'in-app',
      recipient: 'admin_users',
      template: 'calendar-subscription-lapse-admin',
      timing: 'immediate',
    },
  ],
  // BAL-374: onboarding-completion reminder — EMAIL ONLY to the un-onboarded user
  // (recipient 'self' via payload.userId). No in-app (the user hasn't onboarded, the
  // bell is irrelevant). One event fires for all three cadence steps; the step lives
  // in the payload/correlationId, not the rule. Server-only (published by the sweep).
  'onboarding.reminder': [
    {
      channel: 'email',
      recipient: 'self',
      template: 'onboarding-reminder',
      timing: 'immediate',
      priority: 'normal',
    },
  ],
  // BAL-380 (ADR-1040 Lane 3): dormancy reminder + balance expired. Both fan out to
  // the company's MANAGE_BILLING holders (recipient 'company_billing_admins', resolved
  // from data.billingUserIds) via email + in-app. Warm, non-countdown copy; the
  // template switches on payload.window (60|30). Server-only (published by the sweep).
  'credit.dormancy_reminder': emailAndInApp('company_billing_admins', 'credit-dormancy-reminder'),
  'credit.balance_expired': emailAndInApp('company_billing_admins', 'credit-balance-expired'),
  // BAL-379 (ADR-1040): between-session auto-top-up executed / failed. Both fan out to the
  // company's MANAGE_BILLING holders (recipient 'company_billing_admins', resolved from
  // data.billingUserIds) via email + in-app. Warm executed confirmation; calm, non-dunning
  // failed copy. Server-only (published from the Stripe webhook / settlement path post-commit).
  'credit.auto_topup.executed': emailAndInApp(
    'company_billing_admins',
    'credit-auto-topup-executed'
  ),
  'credit.auto_topup.failed': emailAndInApp('company_billing_admins', 'credit-auto-topup-failed'),
  // BAL-378 (ADR-1040 Lane 2): in-session drawdown / settlement notices. Warm, no
  // "overdraft" anywhere (billing admins are client-side too). Self events carry `userId`
  // (resolver hydrates data.user → the SMS `phoneVerifiedAt` gate); fan-out events carry
  // `companyId` → data.billingUserIds. Server-published (meter driver / endSession / webhook /
  // nudge) — every rule's email/sms template MUST exist (getEmailTemplate/getSmsTemplate throw
  // on a missing template → dead job).
  //
  // Low balance: self, in-app only (routine).
  'session.low_balance': [
    {
      channel: 'in-app',
      recipient: 'self',
      template: 'session-low-balance',
      timing: 'immediate',
    },
  ],
  // Grace entered: self in-app + SMS (urgent, verified-phone gated) + an async in-app ping to
  // the billing admins.
  'session.grace_entered': [
    {
      channel: 'in-app',
      recipient: 'self',
      template: 'session-grace-entered',
      timing: 'immediate',
    },
    {
      channel: 'sms',
      recipient: 'self',
      template: 'session-grace-entered-sms',
      timing: 'immediate',
      priority: 'critical',
      condition: recipientPhoneVerified,
    },
    {
      channel: 'in-app',
      recipient: 'company_billing_admins',
      template: 'session-grace-entered-admin',
      timing: 'immediate',
    },
  ],
  // Near wrap: self in-app + SMS (urgent, verified-phone gated).
  'session.near_wrap': [
    {
      channel: 'in-app',
      recipient: 'self',
      template: 'session-near-wrap',
      timing: 'immediate',
    },
    {
      channel: 'sms',
      recipient: 'self',
      template: 'session-near-wrap-sms',
      timing: 'immediate',
      priority: 'critical',
      condition: recipientPhoneVerified,
    },
  ],
  // Settled receipt + settlement-failed dunning: billing admins, email + in-app.
  'session.settled': emailAndInApp('company_billing_admins', 'session-settled'),
  'session.settlement_failed': emailAndInApp('company_billing_admins', 'session-settlement-failed'),
  // Member top-up nudge: billing admins, in-app.
  'session.topup_nudge': [
    {
      channel: 'in-app',
      recipient: 'company_billing_admins',
      template: 'session-topup-nudge',
      timing: 'immediate',
    },
  ],
  // BAL-377 (ADR-1040 Lane 1). A top-up charged successfully → a warm receipt to the
  // PURCHASER (recipient 'self' via payload.userId; email + in-app). Server-published from
  // the Stripe webhook post-commit.
  'credit.topup.completed': emailAndInApp('self', 'credit-topup-completed'),
  // BAL-377 / BAL-381. A member without MANAGE_BILLING nudged the billing holder(s) →
  // fans out to the company's MANAGE_BILLING holders (recipient 'company_billing_admins',
  // resolved from data.billingUserIds) via email + in-app. Publishable from apps/web.
  'credit.topup.requested': emailAndInApp('company_billing_admins', 'credit-topup-requested'),
  // BAL-383 (ADR-1040): promo code redeemed — a warm, retrospective milestone
  // confirmation to the ACTOR who redeemed (recipient 'self' via payload.userId; the
  // resolver hydrates data.user, the delivery worker greets by name). NOT a wallet-state
  // notice, so NOT the company_billing_admins fan-out. Email + in-app, no SMS.
  'promo.redeemed': emailAndInApp('self', 'promo-redeemed'),
  // BAL-399 (ADR-1040 / ADR-1043): Case billing finalized. `payment.charged` is the acting
  // member's PERSONAL consultation receipt (recipient 'self' via payload.userId; email + in-app) —
  // DISTINCT from the billing-admin `session.settled` fan-out (Owner Decision O1: a person who is
  // both simply gets both, no suppression). `payout.recorded` is the delivering expert's own
  // earnings notice (recipient 'expert' via payload.expertProfileId → data.expert; email + in-app).
  // Both server-published once at `finalizeBilling`; templates carry own-side figures ONLY.
  'payment.charged': emailAndInApp('self', 'payment-charged'),
  'payout.recorded': emailAndInApp('expert', 'payout-recorded'),
  // BAL-412 (ADR-1044 §7, D8): the expert never joined — nothing was charged, the hold is
  // released in full. One event, TWO conditioned rules on TWO DIFFERENT recipient kinds (the
  // `recap.ready` two-rules-on-one-event pattern, but neither is conditioned — both always
  // fire, since a `missed_call` settlement always names both parties): the acting member
  // (recipient 'self' via payload.userId, APOLOGETIC register — Balo failed them) and the
  // delivering expert (recipient 'expert' via payload.expertProfileId → data.expert, FACTUAL
  // register — no penalty in v1, but they should know it was recorded). Published EXACTLY ONCE
  // from `finalizeBilling`, gated on `settlementShape === 'missed_call'`.
  'session.missed_call': [
    ...emailAndInApp('self', 'session-missed-call-client'),
    ...emailAndInApp('expert', 'session-missed-call-expert'),
  ],
  // BAL-391 (ADR-1043): an action item was assigned to a SIDE of the engagement. One
  // event, two conditioned rules keyed on payload.assigneeParty (the
  // conversation.message_posted routing precedent, renamed off `project.` by BAL-424) —
  // the assigned side only gets email +
  // in-app: 'client' → recipient:'client' via payload.recipientId (client company
  // owner; skips gracefully when absent); 'expert' → recipient:'expert' via
  // payload.expertProfileId → the resolver hydrates data.expert. NO admin fan-out
  // (assignee-only).
  'action_item.assigned': [
    ...emailAndInApp(
      'client',
      'action-item-assigned',
      (ctx) => ctx.payload.assigneeParty === 'client'
    ),
    ...emailAndInApp(
      'expert',
      'action-item-assigned',
      (ctx) => ctx.payload.assigneeParty === 'expert'
    ),
  ],
  // BAL-387 (ADR-1013 + ADR-1043): a transcript recap is ready. Two-party fan-out (mirrors
  // engagement.cancelled): the CLIENT company owner (recipient:'client' via payload.recipientId
  // — conditioned on its presence so a retainer/no-owner recap skips the client rule) + the
  // delivering EXPERT (recipient:'expert' via payload.expertProfileId → the resolver hydrates
  // data.expert). Email + in-app to each; NO admin fan-out. Carries no money (lens-safe).
  'recap.ready': [
    ...emailAndInApp('client', 'recap-ready', (ctx) => !!ctx.payload.recipientId),
    ...emailAndInApp('expert', 'recap-ready'),
  ],

  // ── BAL-408 / ADR-1044 — the guest participation model ────────────────────────────
  //
  // ⚠ `admit` AND `deny` PUBLISH NOTHING, DELIBERATELY. The person is standing in the
  // lobby watching the UI: an email arriving after a DENY is hostile, and one after an
  // ADMIT is redundant with the door opening in front of them. There is no rule key for
  // either, and adding one would be a product regression rather than a gap.

  // The guest themselves — an EXTERNAL address with no Balo user row, so the dispatcher
  // reads it straight off `payload.recipientEmail` (the `expert.referral_invited` /
  // `proposal.shared` path). EMAIL ONLY: there is no in-app surface for a non-user.
  // ⚠ ONE PUBLISH PER GUEST, never a fan-out — the payload carries that guest's RAW join
  // token, and the dispatcher shares one payload across a fan-out.
  'meeting.guest_invited': [
    {
      channel: 'email',
      recipient: 'email_address',
      template: 'meeting-guest-invited',
      timing: 'immediate',
      priority: 'normal',
    },
  ],

  // The guest's OWN party — a roster-changed FYI. IN-APP ONLY: low signal, and an email
  // per added colleague would be noise. `meeting_party_participants` reads the
  // publisher-resolved `payload.recipientUserIds`; resolving WHO they are is the invite
  // service's job (it already holds the party), which keeps `engine/resolver.ts` free of
  // any `meeting_guests` read.
  'meeting.guest_added': [
    {
      channel: 'in-app',
      recipient: 'meeting_party_participants',
      template: 'meeting-guest-added',
      timing: 'immediate',
    },
  ],

  // That person, and only that person. Email only, same external path as the invite.
  // ⚠ This is the WHOLE of the shipped removal notice — the AC's `METHOD:CANCEL` half is
  // deferred because no meeting has a calendar event to cancel. See
  // `MeetingGuestRemovedPayload`'s docblock for the verification.
  'meeting.guest_removed': [
    {
      channel: 'email',
      recipient: 'email_address',
      template: 'meeting-guest-removed',
      timing: 'immediate',
      priority: 'normal',
    },
  ],

  // BAL-436 — a host re-sent the join link to an admitted guest who never arrived. That
  // person, and only that person; the same external `email_address` path as the invite,
  // because there is no in-app surface for a non-user.
  // ⚠ EMAIL ONLY AND ONE PUBLISH PER RE-SEND — the payload carries a freshly ROTATED RAW join
  // token, and the dispatcher shares one payload across a fan-out. Never widen the recipient.
  // ⚠ `immediate`: the point of a re-send is that somebody is stuck outside a live call.
  'meeting.guest_link_resent': [
    {
      channel: 'email',
      recipient: 'email_address',
      template: 'meeting-guest-link-resent',
      timing: 'immediate',
      priority: 'normal',
    },
  ],

  // ── BAL-134 / ADR-1049 — the two absence promises (§6.2) ────────────────────────────────
  //
  // ⚠⚠ THE BALO-STAFF PATH ALREADY EXISTS — DO NOT INVENT A PARALLEL ONE. The ticket's note
  // that this "may need a separate path rather than a new template" is WRONG:
  // `dispatcher.ts` resolves `recipient: 'admin'` + `channel: 'email'` to the literal
  // `process.env.OPS_NOTIFICATION_EMAIL`, setting BOTH `recipientEmail` and `recipientId` to
  // it, and `notification_log`'s exactly-one CHECK against `recipient_email` keeps the send
  // auditable. The shipped precedent is `project.match_requested` above. A normal rule plus a
  // template IS the pattern.
  //
  // ⚠ `critical`, AND THAT IS NOT DECORATION. Balo has committed to CONTACTING the expert, so
  // a human must actually see this. ⚠ WHEN `OPS_NOTIFICATION_EMAIL` IS UNSET the dispatcher
  // `log.warn`s and SILENTLY SKIPS — which is why BAL-134 adds it to `.env.example` and emits
  // one boot-time `log.warn` from `index.ts`.
  //
  // ⚠ NO IN-APP ARM: ops is an inbox, not a Balo user with a notification bell.
  'meeting.expert_absent': [
    {
      channel: 'email',
      recipient: 'admin',
      template: 'meeting-expert-absent-admin',
      timing: 'immediate',
      priority: 'critical',
    },
  ],

  // The CLIENT company's side — a helpful fact, never a billing threat. `meeting_party_
  // participants` reads the publisher-resolved `payload.recipientUserIds` (rebuilt at fire
  // time by the recheck), which is what keeps a membership read out of `engine/resolver.ts`.
  //
  // ⚠⚠ **NO SMS ARM (D13) — DEFERRED, NOT DROPPED.** The AC says "SMS + in-app"; two
  // INDEPENDENT structural blocks in the shipped code make it unbuildable here. (1)
  // `processSmsJob` resolves the number from `usersRepository.findById(payload.recipientId)
  // .phone`, so a guest or delegate with no user row is unreachable BY CONSTRUCTION — and
  // those are exactly the people BAL-408 exists to support. (2) The `recipientPhoneVerified`
  // gate reads `ctx.data.user`, which the resolver hydrates ONLY on the single-recipient path;
  // a FAN-OUT never populates it, so the verified-phone gate cannot even be EVALUATED on the
  // recipient kind this nudge needs. The AC amendment and a follow-up ticket are recorded in
  // the PR rather than the gap being quietly reinterpreted.
  //
  // ⚠ BOTH ARMS SHARE ONE TEMPLATE NAME, resolved per channel — `getEmailTemplate` throws on a
  // miss (→ a dead job), and `getInAppTemplate` silently degrades to "You have a new
  // notification", so BOTH registries must carry `meeting-client-absent`.
  'meeting.client_absent': [
    {
      channel: 'in-app',
      recipient: 'meeting_party_participants',
      template: 'meeting-client-absent',
      timing: 'immediate',
    },
    {
      channel: 'email',
      recipient: 'meeting_party_participants',
      template: 'meeting-client-absent',
      timing: 'immediate',
      priority: 'normal',
    },
  ],
};
