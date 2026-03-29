// Only events needed for BAL-175 -- add more as features ship

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
