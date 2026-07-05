// Canonical event type definitions — web-side mirror at apps/web/src/lib/notifications/types.ts
// When adding/changing events here, update the web-side types to match

// BAL-290 payloads live in @balo/shared/notifications (shared with apps/web).
import type {
  ProjectChangesRequestedPayload,
  ProjectProposalResubmittedPayload,
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
  | 'project.file_shared';

/**
 * Events published only from WITHIN the API (the calendar webhook and the Cronofy
 * token-refresh path) — never through the internal `/notifications/publish` route,
 * so they have no arm in `publishBodySchema` by design. Keep this list tight:
 * everything NOT listed here is treated as publishable from apps/web and MUST have
 * a schema arm — enforced at compile time in
 * apps/api/src/routes/notifications/schema.ts.
 */
export type ServerOnlyNotificationEvent = 'calendar.auth_error';

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
}
