import type { AuthEventMap, AuthServerEventMap } from './events/auth';
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
import type { SignupDomainServerEventMap } from './events/signup-domain';
import type { OrgIntentServerEventMap } from './events/org-intent';
import type { PartyJoinServerEventMap } from './events/party-join';
import type { EngagementServerEventMap, EngagementEventMap } from './events/engagement';
import type { AdminEngagementsEventMap } from './events/admin-engagements';
import type { DomainJoinEventMap } from './events/domain-join';
import type { ExpertAgencyEventMap } from './events/expert-agency';
import type {
  OnboardingReminderEventMap,
  OnboardingReminderServerEventMap,
} from './events/onboarding-reminder';
import type { CreditEventMap, CreditServerEventMap } from './events/credit';
import type { PromoServerEventMap, PromoEventMap } from './events/promo';
import type { SessionEventMap, SessionServerEventMap } from './events/session';
import type { CaseBillingEventMap, CaseBillingServerEventMap } from './events/case-billing';

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
  BillingEventMap &
  AdminEngagementsEventMap &
  EngagementEventMap &
  DomainJoinEventMap &
  ExpertAgencyEventMap &
  OnboardingReminderEventMap &
  CreditEventMap &
  PromoEventMap &
  SessionEventMap &
  CaseBillingEventMap;

export type EventName = keyof AllEvents;

/** Union of all server-side event maps. */
export type ServerEvents = ExpertServerEventMap &
  ExpertPayoutServerEventMap &
  NotificationServerEventMap &
  CalendarServerEventMap &
  SearchServerEventMap &
  ProjectServerEventMap &
  BillingServerEventMap &
  PartyDomainServerEventMap &
  PartyJoinServerEventMap &
  SignupDomainServerEventMap &
  OrgIntentServerEventMap &
  EngagementServerEventMap &
  AuthServerEventMap &
  OnboardingReminderServerEventMap &
  CreditServerEventMap &
  PromoServerEventMap &
  SessionServerEventMap &
  CaseBillingServerEventMap;

export type ServerEventName = keyof ServerEvents;
