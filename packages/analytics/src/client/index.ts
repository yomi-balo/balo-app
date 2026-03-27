export { initAnalytics, analytics } from './client';
export { track } from './track';
export type { AllEvents, EventName } from '../types';

// Re-export all event constants and types for consumer convenience
export {
  AUTH_EVENTS,
  ONBOARDING_EVENTS,
  EXPERT_EVENTS,
  EXPERT_SETUP_EVENTS,
  EXPERT_RATE_EVENTS,
  EXPERT_PAYOUT_EVENTS,
  AVATAR_EVENTS,
  PHONE_EVENTS,
} from '../events';

export type {
  AuthEventMap,
  AuthMethod,
  OnboardingEventMap,
  OnboardingStepName,
  ExpertEventMap,
  ExpertStepName,
  ExpertSetupEventMap,
  ExpertRateEventMap,
  ExpertPayoutEventMap,
  AvatarEventMap,
  PhoneEventMap,
} from '../events';
