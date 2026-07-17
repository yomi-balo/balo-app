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
  ProposalSharedPayload,
  SessionLowBalancePayload,
  SessionGraceEnteredPayload,
  SessionNearWrapPayload,
  SessionSettledPayload,
  SessionSettlementFailedPayload,
  SessionTopupNudgePayload,
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

export interface ProjectMessagePostedPayload {
  correlationId: string; // message id — dedup per message (dispatcher jobId)
  projectRequestId: string;
  relationshipId: string;
  title: string; // request title
  senderName: string;
  recipientRole: 'client' | 'expert'; // rule condition routes on this
  recipientId?: string; // set when recipientRole==='client' (= createdByUserId) → dispatcher 'client' path
  expertProfileId?: string; // set when recipientRole==='expert' → resolver hydrates data.expert
  preview: string; // plain-text snippet ≤140 (htmlToPlainText)
}

export interface ProjectFileSharedPayload {
  correlationId: string; // file id — dedup per share
  projectRequestId: string;
  relationshipId: string;
  title: string;
  senderName: string;
  recipientRole: 'client' | 'expert';
  recipientId?: string;
  expertProfileId?: string;
  fileName: string;
}

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
  | 'project.message_posted'
  | 'project.file_shared'
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
  | 'party.member_joined_via_domain'
  | 'party.join_request_created'
  | 'party.join_request_approved'
  | 'party.join_request_declined'
  | 'agency.provisioned'
  | 'company.provisioned'
  | 'onboarding.reminder'
  | 'credit.dormancy_reminder'
  | 'credit.balance_expired'
  | 'session.low_balance'
  | 'session.grace_entered'
  | 'session.near_wrap'
  | 'session.settled'
  | 'session.settlement_failed'
  | 'session.topup_nudge';

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
  | 'engagement.auto_accepted'
  | 'engagement.review_reminder'
  | 'onboarding.reminder'
  | 'credit.dormancy_reminder'
  | 'credit.balance_expired'
  | 'session.low_balance'
  | 'session.grace_entered'
  | 'session.near_wrap'
  | 'session.settled'
  | 'session.settlement_failed'
  | 'session.topup_nudge';

/** Events accepted by the internal `/notifications/publish` route (published from apps/web). */
export type PublishableNotificationEvent = Exclude<NotificationEvent, ServerOnlyNotificationEvent>;

export interface EventPayloadMap {
  'user.welcome': UserWelcomePayload;
  'expert.application_submitted': ExpertApplicationSubmittedPayload;
  'expert.approved': ExpertApprovedPayload;
  'expert.referral_invited': ExpertReferralInvitedPayload;
  'calendar.auth_error': CalendarAuthErrorPayload;
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
  'project.message_posted': ProjectMessagePostedPayload;
  'project.file_shared': ProjectFileSharedPayload;
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
  'party.member_joined_via_domain': PartyMemberJoinedViaDomainPayload;
  'party.join_request_created': PartyJoinRequestCreatedPayload;
  'party.join_request_approved': PartyJoinRequestApprovedPayload;
  'party.join_request_declined': PartyJoinRequestDeclinedPayload;
  'agency.provisioned': AgencyProvisionedPayload;
  'company.provisioned': CompanyProvisionedPayload;
  'onboarding.reminder': OnboardingReminderPayload;
  'credit.dormancy_reminder': CreditDormancyReminderPayload;
  'credit.balance_expired': CreditBalanceExpiredPayload;
  'session.low_balance': SessionLowBalancePayload;
  'session.grace_entered': SessionGraceEnteredPayload;
  'session.near_wrap': SessionNearWrapPayload;
  'session.settled': SessionSettledPayload;
  'session.settlement_failed': SessionSettlementFailedPayload;
  'session.topup_nudge': SessionTopupNudgePayload;
}
