// Only events needed for BAL-175 -- add more as features ship

export interface UserWelcomePayload {
  correlationId: string; // userId
  userId: string;
}

export interface ExpertApplicationSubmittedPayload {
  correlationId: string; // applicationId
  userId: string;
  applicationId: string;
}

export type NotificationEvent = 'user.welcome' | 'expert.application_submitted';

export interface EventPayloadMap {
  'user.welcome': UserWelcomePayload;
  'expert.application_submitted': ExpertApplicationSubmittedPayload;
}
