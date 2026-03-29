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

export type NotificationEvent = 'user.welcome' | 'expert.application_submitted';

export interface EventPayloadMap {
  'user.welcome': UserWelcomePayload;
  'expert.application_submitted': ExpertApplicationSubmittedPayload;
}
