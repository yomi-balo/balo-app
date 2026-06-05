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
}

export type NotificationEvent =
  | 'user.welcome'
  | 'expert.application_submitted'
  | 'expert.approved'
  | 'project.request_submitted';

export interface EventPayloadMap {
  'user.welcome': UserWelcomePayload;
  'expert.application_submitted': ExpertApplicationSubmittedPayload;
  'expert.approved': ExpertApprovedPayload;
  'project.request_submitted': ProjectRequestSubmittedPayload;
}
