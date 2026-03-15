import type { AuthEventMap } from './events/auth';
import type { OnboardingEventMap } from './events/onboarding';
import type { ExpertEventMap } from './events/expert';
import type { ExpertSetupEventMap } from './events/expert-setup';
import type { ExpertRateEventMap } from './events/expert-rate';
import type { ExpertPayoutEventMap } from './events/expert-payouts';
import type { AvatarEventMap } from './events/avatar';

/**
 * Union of all event maps in the platform.
 * To add new feature events: create events/<feature>.ts and extend this intersection.
 */
export type AllEvents = AuthEventMap &
  OnboardingEventMap &
  ExpertEventMap &
  ExpertSetupEventMap &
  ExpertRateEventMap &
  ExpertPayoutEventMap &
  AvatarEventMap;

export type EventName = keyof AllEvents;
