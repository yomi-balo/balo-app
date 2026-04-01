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

export type NotificationEvent = 'user.welcome' | 'expert.application_submitted' | 'expert.approved';

export interface EventPayloadMap {
  'user.welcome': UserWelcomePayload;
  'expert.application_submitted': ExpertApplicationSubmittedPayload;
  'expert.approved': ExpertApprovedPayload;
}
