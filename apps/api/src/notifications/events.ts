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

export type NotificationEvent = 'user.welcome' | 'expert.application_submitted' | 'expert.approved';

export interface EventPayloadMap {
  'user.welcome': UserWelcomePayload;
  'expert.application_submitted': ExpertApplicationSubmittedPayload;
  'expert.approved': ExpertApprovedPayload;
}
