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
  CALENDAR_EVENTS,
  SEARCH_EVENTS,
  EXPERT_PROFILE_EVENTS,
  PROJECT_EVENTS,
  CONVERSATION_EVENTS,
  // BAL-283 (round-1 W10) — ⚠ THE RE-EXPORT ALLOWLIST. The canonical call-surface tuple, so
  // the two BAL-283 Server Actions derive their Zod enum from it instead of hand-writing a
  // sixth copy of `['header','rail','nudge']`.
  CONVERSATION_CALL_SURFACES,
  PROJECTS_INBOX_EVENTS,
  BILLING_EVENTS,
  ADMIN_ENGAGEMENTS_EVENTS,
  ENGAGEMENT_EVENTS,
  DOMAIN_JOIN_EVENTS,
  EXPERT_AGENCY_EVENTS,
  ONBOARDING_REMINDER_EVENTS,
  CREDIT_EVENTS,
  PROMO_EVENTS,
  SESSION_EVENTS,
  CASE_BILLING_EVENTS,
  RECAP_EVENTS,
  END_OF_CALL_EVENTS,
  WALLET_EVENTS,
  SCHEDULE_EVENTS,
  MEETING_CALL_EVENTS,
  // BAL-436 — ⚠ THE RE-EXPORT ALLOWLIST. Omitting a name here fails in a DIFFERENT package
  // (`apps/web` cannot import it), not in this one.
  MEETING_PANEL_EVENTS,
  // Availability CLIENT events — BAL-416's conflict warnings AND BAL-236's slot picker.
  // ⚠ `AVAILABILITY_SERVER_EVENTS` must NEVER join this list — it is server-only
  // (exported from '../server' instead).
  AVAILABILITY_EVENTS,
  // BAL-400 — the case-booking flow. ⚠ THE RE-EXPORT ALLOWLIST. Omitting a name here fails in a
  // DIFFERENT package (`apps/web` cannot import it), not in this one.
  BOOKING_EVENTS,
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
  CalendarEventMap,
  SearchEventMap,
  ExpertProfileEventMap,
  ExpertProfileSection,
  ExpertProfileCta,
  ProfileViewport,
  ProjectEventMap,
  ProjectEntryMethod,
  ProjectStep,
  ConversationEventMap,
  ConversationLens,
  ConversationThreadSelectMethod,
  ConversationFilesSurface,
  ConversationCallSurface,
  ConversationProposalSurface,
  ProjectsInboxEventMap,
  ProjectsInboxLens,
  ProjectsInboxFilter,
  BillingEventMap,
  AdminEngagementsEventMap,
  AdminEngagementsFilter,
  EngagementEventMap,
  DomainJoinEventMap,
  ExpertAgencyEventMap,
  ExpertAgencyOutcome,
  OnboardingReminderEventMap,
  OnboardingReminderDomainClass,
  CreditEventMap,
  PromoEventMap,
  SessionEventMap,
  CaseBillingEventMap,
  WalletEventMap,
  WalletLens,
  WalletRestingStateName,
  ScheduleEventMap,
  MeetingCallEventMap,
  MeetingCallLayout,
  MeetingCallLayoutSource,
  MeetingCallLeaveReason,
  MeetingCallGrantRejectionReason,
  MeetingCallDeviceKind,
  // BAL-436 — the side panel's client family.
  MeetingPanelEventMap,
  MeetingPanelId,
  MeetingPanelAdmissionDecision,
  MeetingPanelDecisionOutcome,
  MeetingPanelInviteOutcome,
  MeetingPanelOutcome,
  MeetingPanelFileOutcome,
  MeetingPanelSizeBucket,
  MeetingPanelMessageOutcome,
  MeetingPanelReactionEmoji,
  // BAL-421 — the case surface's client islands annotate their action props with this.
  // ⚠ THE FIRST `Recap*`-FAMILY TYPE IN THIS LIST: `RECAP_EVENTS` was already exported as a
  // VALUE above, but no recap TYPE was, so a client component could not name one. Neither
  // this package nor `apps/web`'s barrel has a check that would have flagged the omission —
  // it surfaces only as an unresolved import in whichever app tries to use it.
  CaseSurfaceAction,
  // Availability CLIENT family — BAL-416's conflict warnings AND BAL-236's slot picker.
  AvailabilityEventMap,
  AvailabilityConflictResolution,
  // BAL-400 — the case-booking flow's client vocabulary.
  BookingEventMap,
  BookingSource,
  BookingEntryMode,
  BookingAbandonStep,
  // BAL-411 CONSIDER item — the reschedule-proposal answer vocabulary.
  RescheduleProposalOutcome,
} from '../events';
