import type { AuthEventMap } from './events/auth';
import type { OnboardingEventMap } from './events/onboarding';
import type { ExpertEventMap, ExpertServerEventMap } from './events/expert';
import type { ExpertSetupEventMap } from './events/expert-setup';
import type { ExpertRateEventMap } from './events/expert-rate';
import type { ExpertPayoutEventMap, ExpertPayoutServerEventMap } from './events/expert-payouts';
import type { AvatarEventMap } from './events/avatar';
import type { PhoneEventMap } from './events/phone';
import type { CalendarEventMap, CalendarServerEventMap } from './events/calendar';
import type { NotificationServerEventMap } from './events/notifications';
import type { SearchEventMap, SearchServerEventMap } from './events/search';
import type { ExpertProfileEventMap } from './events/expert-profile';
import type { ProjectEventMap, ProjectServerEventMap } from './events/project';
import type { ConversationEventMap } from './events/conversation';
import type { ProjectsInboxEventMap } from './events/projects-inbox';
import type { BillingEventMap, BillingServerEventMap } from './events/billing';
import type { PartyDomainServerEventMap } from './events/party-domains';

/** Union of all client-side (browser) event maps. */
export type AllEvents = AuthEventMap &
  OnboardingEventMap &
  ExpertEventMap &
  ExpertSetupEventMap &
  ExpertRateEventMap &
  ExpertPayoutEventMap &
  AvatarEventMap &
  PhoneEventMap &
  CalendarEventMap &
  SearchEventMap &
  ExpertProfileEventMap &
  ProjectEventMap &
  ConversationEventMap &
  ProjectsInboxEventMap &
  BillingEventMap;

export type EventName = keyof AllEvents;

/** Union of all server-side event maps. */
export type ServerEvents = ExpertServerEventMap &
  ExpertPayoutServerEventMap &
  NotificationServerEventMap &
  CalendarServerEventMap &
  SearchServerEventMap &
  ProjectServerEventMap &
  BillingServerEventMap &
  PartyDomainServerEventMap;

export type ServerEventName = keyof ServerEvents;
