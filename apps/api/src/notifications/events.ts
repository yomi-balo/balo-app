// Canonical event type definitions — web-side mirror at apps/web/src/lib/notifications/types.ts
// When adding/changing events here, update the web-side types to match

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
}

export type NotificationEvent =
  | 'user.welcome'
  | 'expert.application_submitted'
  | 'expert.approved'
  | 'calendar.auth_error'
  | 'project.request_submitted';

export interface EventPayloadMap {
  'user.welcome': UserWelcomePayload;
  'expert.application_submitted': ExpertApplicationSubmittedPayload;
  'expert.approved': ExpertApprovedPayload;
  'calendar.auth_error': CalendarAuthErrorPayload;
  'project.request_submitted': ProjectRequestSubmittedPayload;
}
