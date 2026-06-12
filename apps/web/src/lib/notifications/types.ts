// Must stay in sync with apps/api/src/notifications/events.ts
// Kept separate to avoid cross-app import dependency (web → api)

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

// BAL-290 (A6.4) changes-requested loop — targets the EXPERT (via expertProfileId).
export interface ProjectChangesRequestedPayload {
  correlationId: string; // proposalId — distinct row per round, naturally unique
  projectRequestId: string;
  relationshipId: string;
  expertProfileId: string; // → resolver hydrates data.expert; recipient:'expert'
  clientName: string; // requesting client's display name — email/in-app body
  projectTitle: string; // request title — email/in-app body
  section: string; // which part of the proposal needs work
  note: string; // the client's change note — email/in-app body
}

// BAL-290 (A6.4) proposal versioning — targets the CLIENT (via recipientId).
export interface ProjectProposalResubmittedPayload {
  correlationId: string; // "<v2ProposalId>--v<version>" — uuid + version suffix
  projectRequestId: string;
  relationshipId: string;
  recipientId: string; // = client user id → resolves recipient:'client'
  expertName: string; // resubmitting expert's display name — email/in-app body
  projectTitle: string; // request title — email/in-app body
  version: number; // the new proposal version (≥2)
  priceCents: number; // updated proposal price — email/in-app body
  currency: string; // e.g. 'aud' — email/in-app body
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
  | 'project.request_submitted'
  | 'project.match_requested'
  | 'project.exploratory_requested'
  | 'project.expert_invited'
  | 'project.eoi_submitted'
  | 'project.proposal_requested'
  | 'project.proposal_submitted'
  | 'project.proposal_accepted'
  | 'project.changes_requested'
  | 'project.proposal_resubmitted'
  | 'project.message_posted'
  | 'project.file_shared';

export interface EventPayloadMap {
  'user.welcome': UserWelcomePayload;
  'expert.application_submitted': ExpertApplicationSubmittedPayload;
  'expert.approved': ExpertApprovedPayload;
  'project.request_submitted': ProjectRequestSubmittedPayload;
  'project.match_requested': ProjectMatchRequestedPayload;
  'project.exploratory_requested': ProjectExploratoryRequestedPayload;
  'project.expert_invited': ProjectExpertInvitedPayload;
  'project.eoi_submitted': ProjectEoiSubmittedPayload;
  'project.proposal_requested': ProjectProposalRequestedPayload;
  'project.proposal_submitted': ProjectProposalSubmittedPayload;
  'project.proposal_accepted': ProjectProposalAcceptedPayload;
  'project.changes_requested': ProjectChangesRequestedPayload;
  'project.proposal_resubmitted': ProjectProposalResubmittedPayload;
  'project.message_posted': ProjectMessagePostedPayload;
  'project.file_shared': ProjectFileSharedPayload;
}
