import type { AuthEventMap } from './events/auth';
import type { OnboardingEventMap } from './events/onboarding';
import type { ExpertEventMap } from './events/expert';
import type { ExpertSetupEventMap } from './events/expert-setup';
import type { ExpertRateEventMap } from './events/expert-rate';
import type { ExpertPayoutEventMap, ExpertPayoutServerEventMap } from './events/expert-payouts';
import type { AvatarEventMap } from './events/avatar';
import type { NotificationServerEventMap } from './events/notifications';

/** Union of all client-side (browser) event maps. */
export type AllEvents = AuthEventMap &
  OnboardingEventMap &
  ExpertEventMap &
  ExpertSetupEventMap &
  ExpertRateEventMap &
  ExpertPayoutEventMap &
  AvatarEventMap;

export type EventName = keyof AllEvents;

/** Union of all server-side event maps. */
export type ServerEvents = ExpertPayoutServerEventMap & NotificationServerEventMap;

export type ServerEventName = keyof ServerEvents;
