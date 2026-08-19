// Canonical event type definitions — web-side mirror at apps/web/src/lib/notifications/types.ts
// When adding/changing events here, update the web-side types to match

// BAL-290 payloads live in @balo/shared/notifications (shared with apps/web).
import type {
  ProjectChangesRequestedPayload,
  ProjectProposalResubmittedPayload,
  BillingDetailsConfirmedPayload,
  EngagementMilestoneCompletedPayload,
  EngagementMilestoneRevertedPayload,
  EngagementScopeChangedPayload,
  EngagementCompletionRequestedPayload,
  EngagementCompletionWithdrawnPayload,
  EngagementCancelledPayload,
  EngagementAcceptedPayload,
  EngagementChangesRequestedPayload,
  EngagementAutoAcceptedPayload,
  EngagementReviewReminderPayload,
  CompanyProvisionedPayload,
  OnboardingReminderPayload,
  CreditDormancyReminderPayload,
  CreditBalanceExpiredPayload,
  CreditAutoTopupExecutedPayload,
  CreditAutoTopupFailedPayload,
  CreditTopupCompletedPayload,
  CreditTopupRequestedPayload,
  PromoRedeemedPayload,
  ProposalSharedPayload,
  ActionItemAssignedPayload,
  SessionLowBalancePayload,
  SessionGraceEnteredPayload,
  SessionNearWrapPayload,
  SessionSettledPayload,
  SessionSettlementFailedPayload,
  SessionTopupNudgePayload,
  PaymentChargedPayload,
  PayoutRecordedPayload,
  RecapReadyPayload,
  ReviewReminderPayload,
  EngagementCaseClosedPayload,
  MeetingGuestInvitedPayload,
  MeetingGuestAddedPayload,
  MeetingGuestRemovedPayload,
  MeetingGuestLinkResentPayload,
  ConversationMessagePostedPayload,
  ConversationFileSharedPayload,
  ConversationUnreadDigestDuePayload,
  MeetingExpertAbsentPayload,
  MeetingClientAbsentPayload,
} from '@balo/shared/notifications';

export interface UserWelcomePayload {
  correlationId: string; // userId
  userId: string;
  role: 'client' | 'expert';
}

export interface ExpertApplicationSubmittedPayload {
  correlationId: string; // applicationId
  userId: string;
  applicationId: string;
}

export interface ExpertApprovedPayload {
  correlationId: string; // expertProfileId
  userId: string;
  expertProfileId: string;
}

export interface ExpertReferralInvitedPayload {
  correlationId: string; // expert_referral_invites row id — dedup per invite
  // The invited EXTERNAL address — this is BOTH the delivery target and the dedup
  // identity. Carrying an email in the payload is the deliberate PII-in-queue
  // exception (BAL-325 R2): there is no Balo user row to hydrate for a non-user
  // recipient, mirroring the admin/ops-inbox literal-email path.
  recipientEmail: string;
  inviterName: string; // "{First Last}" (or a neutral fallback) — email body
}

export interface CalendarAuthErrorPayload {
  correlationId: string; // connectionId
  expertProfileId: string;
  // BAL-396 §7 — required, not optional: both publishers (the two Cronofy call sites this PR
  // rewrites/deletes) already hold `connection.provider`. Drives the template's
  // `providerLabel` copy.
  provider: string;
}

/**
 * BAL-468 §15 — the daily calendar-subscription monitor's non-zero-arm alert. SERVER-ONLY,
 * declared INLINE in this file — deliberately, and the exception TO
 * `reference_notification_event_dup_shared_home`, not a violation of it: the web mirror
 * (`apps/web/src/lib/notifications/types.ts`) omits server-only events by design (exactly as
 * it omits `calendar.auth_error`), so there is no second copy of this shape and no clone.
 * `CalendarAuthErrorPayload` above is the in-repo precedent for an inline server-only payload.
 *
 * `correlationId` is date-keyed (`calendar_subscription_lapse:${YYYY-MM-DD}`), not a uuid —
 * one alert per sweep day; a same-day retry collapses on the publisher's jobId while a
 * genuinely new day re-alerts. Precedent: `wallet-dormancy-sweep`'s
 * `${walletId}:dormancy_reminder:${band}:${expiresAtDate}`.
 */
export interface CalendarSubscriptionLapsePayload {
  correlationId: string;
  expiringCount: number;
  unconfirmedCount: number;
  unsubscribedConnectionCount: number;
}

export interface ProjectRequestSubmittedPayload {
  correlationId: string; // projectRequestId
  projectRequestId: string;
  expertProfileId: string; // target expert (recipient resolution)
  companyId: string; // buyer org (context/audit)
  title: string; // email subject/body
  sendTo: 'direct'; // always direct for this event (match has its own event)
  tagIds: string[]; // selected project-type tag ids (counts in template)
  productIds: string[]; // selected product ids (counts in template)
  documentCount: number; // number of attached documents (counts in template)
}

export interface ProjectMatchRequestedPayload {
  correlationId: string; // projectRequestId
  projectRequestId: string;
  companyId: string; // buyer org (recipient/context resolution)
  title: string; // email subject/body
  tagIds: string[];
  productIds: string[];
  documentCount: number;
  // No expertProfileId — match mode has no target expert; routes to ops/admin.
}

export interface ProjectExploratoryRequestedPayload {
  correlationId: string; // projectRequestId — dedup
  recipientId: string; // = createdByUserId → resolves recipient:'client'
  projectRequestId: string;
  title: string; // email/in-app body
}

export interface ProjectExpertInvitedPayload {
  correlationId: string; // relationshipId — dedup per (expert, request)
  projectRequestId: string;
  expertProfileId: string; // → resolver hydrates data.expert; recipient:'expert'
  title: string;
}

export interface ProjectEoiSubmittedPayload {
  correlationId: string; // EOI id — dedup per submission
  recipientId: string; // = createdByUserId → resolves recipient:'client'
  projectRequestId: string;
  title: string; // request title — email/in-app body
  expertName: string; // invited expert's display name — email/in-app body
}

export interface ProjectProposalRequestedPayload {
  correlationId: string; // relationshipId — the transition is one-way ⇒ natural one-shot dedup
  projectRequestId: string;
  relationshipId: string;
  expertProfileId: string; // → resolver hydrates data.expert; recipient:'expert'
  title: string; // request title — email/in-app body
  initiatedBy: 'client' | 'admin'; // BAL-315 — gates the client heads-up rule (admin-on-behalf only)
  recipientId?: string; // BAL-315 — client (request owner) user id; set on the admin path only
}

export interface ProjectProposalSubmittedPayload {
  correlationId: string; // proposalId — dedup per submitted proposal
  projectRequestId: string;
  relationshipId: string;
  recipientId: string; // = client user id → resolves recipient:'client'
  expertName: string; // submitting expert's display name — email/in-app body
  title: string; // request title — email/in-app body
}

export interface ProjectProposalAcceptedPayload {
  correlationId: string; // proposalId — dedup per accepted proposal
  projectRequestId: string;
  relationshipId: string; // the ACCEPTED relationship
  expertProfileId: string; // winning expert's profile id → resolver hydrates data.expert
  clientName: string; // accepting client's display name — email/in-app body
  clientCompanyName: string; // client's company name — email/in-app body
  title: string; // request title — email/in-app body
  priceCents: number; // proposal price — admin ops notification body
  currency: string; // e.g. 'aud' — admin ops notification body
}

export interface ProjectKickoffApprovedPayload {
  correlationId: string; // engagement/kickoff correlation — dedup per kickoff approval
  projectRequestId: string;
  relationshipId: string; // the kicked-off relationship
  expertProfileId: string; // delivering expert's profile id → resolver hydrates data.expert
  recipientId: string; // = client user id → resolves recipient:'client'
  title: string; // request title — email/in-app body
  expertName: string; // delivering expert's display name — email/in-app body
  clientName: string; // approving client's display name — email/in-app body
  clientCompanyName: string; // client's company name — email/in-app body
}

// BAL-424: `ProjectMessagePostedPayload` / `ProjectFileSharedPayload` were declared here.
// They are now `ConversationMessagePostedPayload` / `ConversationFileSharedPayload` in
// `@balo/shared/notifications` (imported above) — re-anchored off
// `request_expert_relationships` onto the ADR-1045 §2 context seam, so one event serves a
// project relationship AND a case. Declaring them in both catalogs would trip the SonarCloud
// new-code duplication gate.

// BAL-324 admin-initiated billing reminder (kickoff board → outstanding
// client-billing gate). `correlationId` is minted PER CLICK (crypto.randomUUID)
// — NOT a stable id — so a deliberate re-remind is a genuinely new dispatch, not
// a BullMQ jobId no-op. One publish fans out to the OWNER (recipient:'client' via
// `recipientId`, email + in-app, CTA) and — only when set — the request CREATOR
// (recipient:'billing_creator' via `creatorUserId`, email + in-app FYI, no CTA).
export interface ProjectBillingReminderPayload {
  correlationId: string; // minted per click (uuid) — dedup a retry, not a re-click
  projectRequestId: string;
  title: string; // request title — email/in-app body
  companyName: string; // buyer org name — email/in-app body
  recipientId: string; // ownerUserId → recipient:'client' (owner, CTA)
  creatorUserId?: string; // → recipient:'billing_creator' (creator, no CTA); set only when != owner & member
}

// BAL-345 domain auto-join. All four share one shape: `userId` is the SUBJECT
// (the joiner, or the requester) so the resolver's existing `payload.userId →
// data.user` hydration names the actor in every template with no new resolver
// code. `correlationId` is the stable membership id (member_joined) or join
// request id (the three request events) → the BullMQ jobId dedup key. Mirrors
// apps/web/src/lib/notifications/types.ts.
interface PartyJoinEventBase {
  correlationId: string;
  partyType: 'company' | 'agency';
  partyId: string;
  userId: string;
}
export type PartyMemberJoinedViaDomainPayload = PartyJoinEventBase; // correlationId = membershipId
export type PartyJoinRequestCreatedPayload = PartyJoinEventBase; // correlationId = joinRequestId
export type PartyJoinRequestApprovedPayload = PartyJoinEventBase; // correlationId = joinRequestId
export type PartyJoinRequestDeclinedPayload = PartyJoinEventBase; // correlationId = joinRequestId

// BAL-348 / BAL-356 — a corporate expert PROVISIONED a new agency (signer became
// owner). Published post-commit by the web write action ONLY on the fresh-create
// (corporate) branch — never on SOLO / JOIN / already_linked (corporate-only gating
// lives at the emit site; the engine adds none). `ownerUserId` is the new owner
// (subject + recipient — the payload deliberately uses `ownerUserId`, NOT `userId`,
// so neither the `self` recipient nor the auto `payload.userId → data.user`
// hydration fires; a dedicated `owner` recipient + agency hydration branch handle
// it). `correlationId` is the stable `agencyId` → BullMQ jobId dedup key, so a retry
// after a partial failure never double-notifies. Mirror of
// apps/web/src/lib/notifications/types.ts — keep the two in lockstep.
export interface AgencyProvisionedPayload {
  correlationId: string; // = agencyId → BullMQ jobId dedup
  agencyId: string;
  ownerUserId: string; // the new owner (subject + recipient)
}

export type NotificationEvent =
  | 'user.welcome'
  | 'expert.application_submitted'
  | 'expert.approved'
  | 'expert.referral_invited'
  | 'calendar.auth_error'
  // BAL-468 — the daily calendar-subscription monitor's non-zero-arm alert. SERVER-ONLY.
  | 'calendar.subscription_lapse'
  | 'project.request_submitted'
  | 'project.match_requested'
  | 'project.exploratory_requested'
  | 'project.expert_invited'
  | 'project.eoi_submitted'
  | 'project.proposal_requested'
  | 'project.proposal_submitted'
  | 'project.proposal_accepted'
  | 'project.kickoff_approved'
  | 'project.changes_requested'
  | 'project.proposal_resubmitted'
  | 'project.billing_reminder'
  | 'proposal.shared'
  | 'billing.details_confirmed'
  | 'engagement.milestone_completed'
  | 'engagement.milestone_reverted'
  | 'engagement.scope_changed'
  | 'engagement.completion_requested'
  | 'engagement.completion_withdrawn'
  | 'engagement.cancelled'
  | 'engagement.accepted'
  | 'engagement.changes_requested'
  | 'engagement.auto_accepted'
  | 'engagement.review_reminder'
  // BAL-390 — a case was closed (fused close + rating ask). LIVE as of BAL-388: the recap's
  // `resolveCaseAction` publishes it from apps/web. The `auto_inactive` close is still
  // unpublished (BAL-420's sweep).
  | 'engagement.case_closed'
  // BAL-390 — the star-rating nudge (+24h / +7d). SERVER-ONLY. NOT the same thing as
  // `engagement.review_reminder` above, which is BAL-338's pre-auto-accept nudge.
  | 'review.reminder'
  | 'party.member_joined_via_domain'
  | 'party.join_request_created'
  | 'party.join_request_approved'
  | 'party.join_request_declined'
  | 'agency.provisioned'
  | 'company.provisioned'
  | 'onboarding.reminder'
  | 'credit.dormancy_reminder'
  | 'credit.balance_expired'
  | 'credit.auto_topup.executed'
  | 'credit.auto_topup.failed'
  | 'session.low_balance'
  | 'session.grace_entered'
  | 'session.near_wrap'
  | 'session.settled'
  | 'session.settlement_failed'
  | 'session.topup_nudge'
  | 'credit.topup.completed'
  | 'credit.topup.requested'
  | 'promo.redeemed'
  | 'payment.charged'
  | 'payout.recorded'
  | 'action_item.assigned'
  | 'recap.ready'
  // BAL-408 — the guest participation model. All three are SERVER-ONLY (see below): the
  // invite/remove mutations are `apps/api` routes, because admit/deny needs the engagement
  // axis (which is api-only) and because the invite email carries the guest's ONLY join
  // credential — `apps/web`'s publisher is fire-and-forget and swallows a non-2xx.
  | 'meeting.guest_invited'
  | 'meeting.guest_added'
  | 'meeting.guest_removed'
  // BAL-436 — a host re-sent an admitted-but-never-arrived guest's join link, ROTATING their
  // credential. SERVER-ONLY for the same second reason as `meeting.guest_invited`: it carries
  // the guest's ONLY join credential, and minting in `apps/api` keeps that secret inside one
  // process from creation to enqueue.
  | 'meeting.guest_link_resent'
  // BAL-134 / ADR-1049 — the two ABSENCE promises. Both SERVER-ONLY (see below): both are
  // published EXCLUSIVELY by BAL-420's dispatch tick, and `scheduleNotification` is an
  // in-process `apps/api` function that ADR-1047 Decision 11 keeps off HTTP entirely.
  | 'meeting.expert_absent'
  | 'meeting.client_absent'
  // BAL-424 — the conversation primitive, re-anchored off `request_expert_relationships`
  // onto the ADR-1045 §2 context seam. RENAMED from `project.message_posted` /
  // `project.file_shared`: the payload had to change anyway (the anchor became the seam),
  // and a `project.` prefix on an event that fires for a Case would make
  // `notification_log.event`, every Axiom query and every future rule condition read
  // `project.*` for a message with no project.
  | 'conversation.message_posted'
  | 'conversation.file_shared'
  | 'conversation.unread_digest_due';

/**
 * Events published only from WITHIN the API (the calendar webhook / Cronofy
 * token-refresh path, the D7 auto-accept + review-reminder sweeps, the BAL-374
 * onboarding-reminder sweep, and the BAL-380 dormancy/expiry sweep) — never through the
 * internal `/notifications/publish` route, so they have no arm in `publishBodySchema` by
 * design. Keep this list tight: everything NOT listed here is treated as publishable
 * from apps/web and MUST have a schema arm — enforced at compile time in
 * apps/api/src/routes/notifications/schema.ts.
 */
export type ServerOnlyNotificationEvent =
  | 'calendar.auth_error'
  // BAL-468: published exclusively by the API's daily `calendar-subscription-monitor` sweep —
  // never from apps/web, so it has no `publishBodySchema` arm; adding one would be a
  // `StraySchemaArm` and fail `tsc`.
  | 'calendar.subscription_lapse'
  | 'engagement.auto_accepted'
  | 'engagement.review_reminder'
  | 'onboarding.reminder'
  | 'credit.dormancy_reminder'
  | 'credit.balance_expired'
  // BAL-379: both fire from the API Stripe webhook / settlement path post-commit — never from
  // apps/web, so neither has a publishBodySchema arm.
  | 'credit.auto_topup.executed'
  | 'credit.auto_topup.failed'
  | 'session.low_balance'
  | 'session.grace_entered'
  | 'session.near_wrap'
  | 'session.settled'
  | 'session.settlement_failed'
  | 'session.topup_nudge'
  // BAL-377: the top-up receipt is published from the API Stripe webhook post-commit —
  // never through the internal /notifications/publish route (no publishBodySchema arm).
  | 'credit.topup.completed'
  // BAL-399: both fire from `finalizeBilling` (the endSession / external-finalizer path) —
  // never from apps/web, so neither has a publishBodySchema arm.
  | 'payment.charged'
  | 'payout.recorded'
  // BAL-387: published from the transcript pipeline worker post-`markRecapPublished` —
  // never from apps/web, so it has no publishBodySchema arm.
  | 'recap.ready'
  // BAL-390: the star-rating nudge is published by the API's hourly review-nudge sweep —
  // never from apps/web, so it has no publishBodySchema arm (adding one would be a
  // `StraySchemaArm` and fail `tsc`). ⚠ `engagement.case_closed` is deliberately NOT
  // listed: BAL-421's publisher is a web Server Action and needs its arm.
  | 'review.reminder'
  // BAL-408: all three are published by `apps/api`'s guest-participation service
  // (`services/meetings/guest-participation.ts`) — never from apps/web, so none has a
  // `publishBodySchema` arm. Adding one would be a `StraySchemaArm` and fail `tsc`.
  // ⚠ `meeting.guest_invited` MUST stay server-only for a second, independent reason: it
  // carries the RAW join token, and minting in `apps/api` keeps that secret inside ONE
  // process from creation to enqueue rather than crossing a service boundary.
  | 'meeting.guest_invited'
  | 'meeting.guest_added'
  | 'meeting.guest_removed'
  // BAL-436: published by the SAME service (`resendGuestJoinLink`) and carrying the same
  // class of secret as `meeting.guest_invited` — a RAW join token. No `publishBodySchema`
  // arm; adding one would be a `StraySchemaArm` and fail `tsc`.
  | 'meeting.guest_link_resent'
  // BAL-134: both absence promises are published EXCLUSIVELY by the BAL-420 dispatch tick, so
  // neither has a `publishBodySchema` arm; adding one would be a `StraySchemaArm` and fail
  // `tsc`. ⚠ `meeting.expert_absent` MUST stay server-only for a SECOND, INDEPENDENT reason:
  // it resolves `recipient: 'admin'`, i.e. it is a BALO-FACING ALERT — and
  // `WebSchedulableNotificationEvent`'s own docblock makes that API-only BY CONSTRUCTION,
  // because `replace_pending` is itself a suppression primitive and this alert exists precisely
  // because somebody might prefer Balo not to know. `web-schedulable-policy.test.ts` asserts it.
  | 'meeting.expert_absent'
  | 'meeting.client_absent'
  // BAL-424: the debounced unread digest is published EXCLUSIVELY by the BAL-420 dispatch
  // tick (`jobs/scheduled-notification-dispatch.ts`) — `scheduleNotification` is an
  // in-process `apps/api` function and ADR-1047 Decision 11 keeps the schedule/cancel seam
  // off HTTP entirely. So it has no `publishBodySchema` arm; adding one would be a
  // `StraySchemaArm` and fail `tsc`. ⚠ `conversation.message_posted` /
  // `conversation.file_shared` are deliberately NOT listed: both are published by web
  // Server Actions and need their arms.
  | 'conversation.unread_digest_due';

/** Events accepted by the internal `/notifications/publish` route (published from apps/web). */
export type PublishableNotificationEvent = Exclude<NotificationEvent, ServerOnlyNotificationEvent>;

/**
 * BAL-420 / ADR-1047 Decision 10 — the ONLY events `apps/web` may SCHEDULE through the
 * (not-yet-built) HTTP seam. Must be a subset of `PublishableNotificationEvent`.
 *
 * Answering this HERE is what makes that route mechanical whenever it is eventually added;
 * shipping an inert route instead would defer the question while adding surface. There is no
 * schedule route in this PR, and there will NEVER be a cancel route (Decision 11).
 *
 * ⚠ THE TEST FOR ADDING ONE: could a caller holding `INTERNAL_API_SECRET` — a build-time env
 * var present in every Vercel preview deployment — use a schedule on this event to stop Balo
 * learning something, or to make Balo learn something false? If yes, it is API-only,
 * PERMANENTLY.
 *
 *  · PARTY-FACING NUDGES pass. The worst a hostile caller achieves is nudging, or failing to
 *    nudge, a party about their own business.
 *  · BALO-FACING ALERTS fail, and not hypothetically: `replace_pending` IS ITSELF A
 *    SUPPRESSION PRIMITIVE. A caller who can schedule the same event with the same key can
 *    supersede a pending alert's `scheduled_for` and payload — pushing it arbitrarily far
 *    out, or replacing its contents. Such an alert exists precisely because someone might
 *    prefer Balo not to know.
 *
 * MECHANICAL COROLLARY, checkable rather than judged: any event whose `notificationRules`
 * entry resolves a `recipient: 'admin'` delivery is API-only BY CONSTRUCTION. That is
 * asserted by `web-schedulable-policy.test.ts`, not left to review.
 *
 * EMPTY until a web-side consumer ships. BAL-411 is the only candidate, and it may well end
 * up API-side too.
 */
export type WebSchedulableNotificationEvent = never;

/**
 * The RUNTIME mirror of `WebSchedulableNotificationEvent`, kept in lockstep with it by the
 * guards below. A `never` type cannot be iterated, and the corollary above has to be
 * ASSERTED against something — so the list exists, and adding to the type without adding
 * here (or vice versa) fails `tsc` rather than quietly disarming the test.
 */
export const WEB_SCHEDULABLE_EVENTS =
  [] as const satisfies readonly WebSchedulableNotificationEvent[];

/**
 * Compile-time guards for the policy above, mirroring `AssertPublishCoverageComplete`'s
 * shape in `routes/notifications/schema.ts`. Split per direction so neither branch forms a
 * `never | never` union (S6571).
 *
 *  1. every web-schedulable event must also be web-PUBLISHABLE — scheduling an event
 *     `apps/web` may not publish at all would be a strictly wider grant;
 *  2. the type and its runtime mirror must name exactly the same events.
 */
type StrayWebSchedulable = Exclude<WebSchedulableNotificationEvent, PublishableNotificationEvent>;
type MissingWebSchedulableConst = Exclude<
  WebSchedulableNotificationEvent,
  (typeof WEB_SCHEDULABLE_EVENTS)[number]
>;
type StrayWebSchedulableConst = Exclude<
  (typeof WEB_SCHEDULABLE_EVENTS)[number],
  WebSchedulableNotificationEvent
>;

type AssertNever<T extends never> = T;

export type AssertWebSchedulableIsPublishable = AssertNever<StrayWebSchedulable>;
export type AssertWebSchedulableConstComplete = [
  AssertNever<MissingWebSchedulableConst>,
  AssertNever<StrayWebSchedulableConst>,
];

export interface EventPayloadMap {
  'user.welcome': UserWelcomePayload;
  'expert.application_submitted': ExpertApplicationSubmittedPayload;
  'expert.approved': ExpertApprovedPayload;
  'expert.referral_invited': ExpertReferralInvitedPayload;
  'calendar.auth_error': CalendarAuthErrorPayload;
  'calendar.subscription_lapse': CalendarSubscriptionLapsePayload;
  'project.request_submitted': ProjectRequestSubmittedPayload;
  'project.match_requested': ProjectMatchRequestedPayload;
  'project.exploratory_requested': ProjectExploratoryRequestedPayload;
  'project.expert_invited': ProjectExpertInvitedPayload;
  'project.eoi_submitted': ProjectEoiSubmittedPayload;
  'project.proposal_requested': ProjectProposalRequestedPayload;
  'project.proposal_submitted': ProjectProposalSubmittedPayload;
  'project.proposal_accepted': ProjectProposalAcceptedPayload;
  'project.kickoff_approved': ProjectKickoffApprovedPayload;
  'project.changes_requested': ProjectChangesRequestedPayload;
  'project.proposal_resubmitted': ProjectProposalResubmittedPayload;
  'project.billing_reminder': ProjectBillingReminderPayload;
  'proposal.shared': ProposalSharedPayload;
  'billing.details_confirmed': BillingDetailsConfirmedPayload;
  'engagement.milestone_completed': EngagementMilestoneCompletedPayload;
  'engagement.milestone_reverted': EngagementMilestoneRevertedPayload;
  'engagement.scope_changed': EngagementScopeChangedPayload;
  'engagement.completion_requested': EngagementCompletionRequestedPayload;
  'engagement.completion_withdrawn': EngagementCompletionWithdrawnPayload;
  'engagement.cancelled': EngagementCancelledPayload;
  'engagement.accepted': EngagementAcceptedPayload;
  'engagement.changes_requested': EngagementChangesRequestedPayload;
  'engagement.auto_accepted': EngagementAutoAcceptedPayload;
  'engagement.review_reminder': EngagementReviewReminderPayload;
  'engagement.case_closed': EngagementCaseClosedPayload;
  'review.reminder': ReviewReminderPayload;
  'party.member_joined_via_domain': PartyMemberJoinedViaDomainPayload;
  'party.join_request_created': PartyJoinRequestCreatedPayload;
  'party.join_request_approved': PartyJoinRequestApprovedPayload;
  'party.join_request_declined': PartyJoinRequestDeclinedPayload;
  'agency.provisioned': AgencyProvisionedPayload;
  'company.provisioned': CompanyProvisionedPayload;
  'onboarding.reminder': OnboardingReminderPayload;
  'credit.dormancy_reminder': CreditDormancyReminderPayload;
  'credit.balance_expired': CreditBalanceExpiredPayload;
  'credit.auto_topup.executed': CreditAutoTopupExecutedPayload;
  'credit.auto_topup.failed': CreditAutoTopupFailedPayload;
  'session.low_balance': SessionLowBalancePayload;
  'session.grace_entered': SessionGraceEnteredPayload;
  'session.near_wrap': SessionNearWrapPayload;
  'session.settled': SessionSettledPayload;
  'session.settlement_failed': SessionSettlementFailedPayload;
  'session.topup_nudge': SessionTopupNudgePayload;
  'credit.topup.completed': CreditTopupCompletedPayload;
  'credit.topup.requested': CreditTopupRequestedPayload;
  'promo.redeemed': PromoRedeemedPayload;
  'payment.charged': PaymentChargedPayload;
  'payout.recorded': PayoutRecordedPayload;
  'action_item.assigned': ActionItemAssignedPayload;
  'recap.ready': RecapReadyPayload;
  'meeting.guest_invited': MeetingGuestInvitedPayload;
  'meeting.guest_added': MeetingGuestAddedPayload;
  'meeting.guest_removed': MeetingGuestRemovedPayload;
  'meeting.guest_link_resent': MeetingGuestLinkResentPayload;
  'meeting.expert_absent': MeetingExpertAbsentPayload;
  'meeting.client_absent': MeetingClientAbsentPayload;
  'conversation.message_posted': ConversationMessagePostedPayload;
  'conversation.file_shared': ConversationFileSharedPayload;
  'conversation.unread_digest_due': ConversationUnreadDigestDuePayload;
}
