import type { AuthEventMap } from './events/auth';
import type { OnboardingEventMap } from './events/onboarding';
import type { ExpertEventMap } from './events/expert';

/**
 * Union of all event maps in the platform.
 * To add new feature events: create events/<feature>.ts and extend this intersection.
 */
export type AllEvents = AuthEventMap & OnboardingEventMap & ExpertEventMap;

export type EventName = keyof AllEvents;
