// Must stay in sync with apps/api/src/notifications/events.ts
// Kept separate to avoid cross-app import dependency (web → api)

// BAL-290 payloads live in @balo/shared/notifications (shared with apps/api).
import type {
  ProjectChangesRequestedPayload,
  ProjectProposalResubmittedPayload,
  BillingDetailsConfirmedPayload,
  EngagementMilestoneCompletedPayload,
  EngagementMilestoneRevertedPayload,
} from '@balo/shared/notifications';

export interface UserWelcomePayload {
  correlationId: string;
  userId: string;
  role: 'client' | 'expert';
}

export interface ExpertApplicationSubmittedPayload {
  correlationId: string;
  userId: string;
  applicationId: string;
}

export interface ExpertApprovedPayload {
  correlationId: string;
  userId: string;
  expertProfileId: string;
}

export interface ExpertReferralInvitedPayload {
  correlationId: string; // expert_referral_invites row id — dedup per invite
  recipientEmail: string; // the invited EXTERNAL address — delivery + dedup identity
  inviterName: string; // "{First Last}" (or a neutral fallback) — email body
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
// request id (the three request events) → the BullMQ jobId dedup key.
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

export type NotificationEvent =
  | 'user.welcome'
  | 'expert.application_submitted'
  | 'expert.approved'
  | 'expert.referral_invited'
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
  | 'billing.details_confirmed'
  | 'engagement.milestone_completed'
  | 'engagement.milestone_reverted'
  | 'party.member_joined_via_domain'
  | 'party.join_request_created'
  | 'party.join_request_approved'
  | 'party.join_request_declined';

export interface EventPayloadMap {
  'user.welcome': UserWelcomePayload;
  'expert.application_submitted': ExpertApplicationSubmittedPayload;
  'expert.approved': ExpertApprovedPayload;
  'expert.referral_invited': ExpertReferralInvitedPayload;
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
  'billing.details_confirmed': BillingDetailsConfirmedPayload;
  'engagement.milestone_completed': EngagementMilestoneCompletedPayload;
  'engagement.milestone_reverted': EngagementMilestoneRevertedPayload;
  'party.member_joined_via_domain': PartyMemberJoinedViaDomainPayload;
  'party.join_request_created': PartyJoinRequestCreatedPayload;
  'party.join_request_approved': PartyJoinRequestApprovedPayload;
  'party.join_request_declined': PartyJoinRequestDeclinedPayload;
}
