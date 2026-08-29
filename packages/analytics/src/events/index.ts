export {
  AUTH_EVENTS,
  AUTH_SERVER_EVENTS,
  type AuthEventMap,
  type AuthServerEventMap,
  type AuthMethod,
  type AuthMethodSignal,
} from './auth';
export { ONBOARDING_EVENTS, type OnboardingEventMap, type OnboardingStepName } from './onboarding';
export {
  EXPERT_EVENTS,
  type ExpertEventMap,
  type ExpertStepName,
  type DraftFlushOutcome,
  EXPERT_SERVER_EVENTS,
  type ExpertServerEventMap,
} from './expert';
export {
  EXPERT_SETUP_EVENTS,
  type ExpertSetupEventMap,
  EXPERT_SETUP_SERVER_EVENTS,
  type ExpertSetupServerEventMap,
} from './expert-setup';
export { EXPERT_RATE_EVENTS, type ExpertRateEventMap } from './expert-rate';
export {
  EXPERT_PAYOUT_EVENTS,
  type ExpertPayoutEventMap,
  EXPERT_PAYOUT_SERVER_EVENTS,
  type ExpertPayoutServerEventMap,
} from './expert-payouts';
export { AVATAR_EVENTS, type AvatarEventMap } from './avatar';
export { PHONE_EVENTS, type PhoneEventMap } from './phone';
export {
  CALENDAR_EVENTS,
  type CalendarEventMap,
  CALENDAR_SERVER_EVENTS,
  type CalendarServerEventMap,
  toCalendarEventProvider,
} from './calendar';
export { NOTIFICATION_SERVER_EVENTS, type NotificationServerEventMap } from './notifications';
export {
  SEARCH_EVENTS,
  type SearchEventMap,
  SEARCH_SERVER_EVENTS,
  type SearchServerEventMap,
} from './search';
export {
  EXPERT_PROFILE_EVENTS,
  type ExpertProfileEventMap,
  type ExpertProfileSection,
  type ExpertProfileCta,
  type ProfileViewport,
} from './expert-profile';
export {
  PROJECT_EVENTS,
  type ProjectEventMap,
  type ProjectEntryMethod,
  type ProjectStep,
  PROJECT_SERVER_EVENTS,
  type ProjectServerEventMap,
  type ProjectRequestAccessDenialReason,
} from './project';
export {
  CONVERSATION_EVENTS,
  type ConversationEventMap,
  type ConversationLens,
  type ConversationThreadSelectMethod,
  type ConversationFilesSurface,
  // BAL-283 (round-1 W10) — the VALUE tuple as well as the type: Server Actions derive their
  // Zod enum from it rather than hand-writing a sixth copy of the surface list.
  CONVERSATION_CALL_SURFACES,
  type ConversationCallSurface,
  type ConversationProposalSurface,
} from './conversation';
export {
  PROJECTS_INBOX_EVENTS,
  type ProjectsInboxEventMap,
  type ProjectsInboxLens,
  type ProjectsInboxFilter,
} from './projects-inbox';
export {
  BILLING_EVENTS,
  type BillingEventMap,
  BILLING_SERVER_EVENTS,
  type BillingServerEventMap,
} from './billing';
export { PARTY_DOMAIN_SERVER_EVENTS, type PartyDomainServerEventMap } from './party-domains';
export {
  SIGNUP_DOMAIN_SERVER_EVENTS,
  type SignupDomainServerEventMap,
  type SignupDomainClass,
} from './signup-domain';
export { ORG_INTENT_SERVER_EVENTS, type OrgIntentServerEventMap } from './org-intent';
export { PARTY_JOIN_SERVER_EVENTS, type PartyJoinServerEventMap } from './party-join';
export { DOMAIN_JOIN_EVENTS, type DomainJoinEventMap } from './domain-join';
export {
  EXPERT_AGENCY_EVENTS,
  type ExpertAgencyEventMap,
  type ExpertAgencyOutcome,
} from './expert-agency';
export {
  ENGAGEMENT_SERVER_EVENTS,
  type EngagementServerEventMap,
  type EngagementWorkspaceLens,
  type EngagementWorkspaceEntry,
  type EngagementAcceptanceMethod,
  ENGAGEMENT_EVENTS,
  type EngagementEventMap,
} from './engagement';
export {
  ADMIN_ENGAGEMENTS_EVENTS,
  type AdminEngagementsEventMap,
  type AdminEngagementsFilter,
} from './admin-engagements';
export {
  ONBOARDING_REMINDER_SERVER_EVENTS,
  type OnboardingReminderServerEventMap,
  ONBOARDING_REMINDER_EVENTS,
  type OnboardingReminderEventMap,
  type OnboardingReminderDomainClass,
} from './onboarding-reminder';
export {
  CREDIT_EVENTS,
  type CreditEventMap,
  CREDIT_SERVER_EVENTS,
  type CreditServerEventMap,
  type FxDisplayQuoteCode,
} from './credit';
export {
  PROMO_SERVER_EVENTS,
  type PromoServerEventMap,
  PROMO_EVENTS,
  type PromoEventMap,
} from './promo';
export {
  SESSION_EVENTS,
  type SessionEventMap,
  SESSION_SERVER_EVENTS,
  type SessionServerEventMap,
} from './session';
export {
  CASE_BILLING_EVENTS,
  type CaseBillingEventMap,
  CASE_BILLING_SERVER_EVENTS,
  type CaseBillingServerEventMap,
  type CaseBillingFinalizationPath,
} from './case-billing';
export {
  RECAP_EVENTS,
  type RecapEventMap,
  RECAP_SERVER_EVENTS,
  type RecapServerEventMap,
  type RecapState,
  type RecapLens,
  type RecapContextType,
  type RecapEntrySource,
  type RecapResolvePromptVariant,
  type RecapCta,
  type CaseSurfaceAction,
  type CaseSurfaceState,
  type CaseResolveSource,
  // BAL-440 — the recording posture dimension on `recap_viewed`, and `deriveRecordingState`'s
  // (apps/web) return type.
  type RecapRecordingState,
} from './recap';
export {
  END_OF_CALL_EVENTS,
  type EndOfCallEventMap,
  END_OF_CALL_SERVER_EVENTS,
  type EndOfCallServerEventMap,
  type EndOfCallRecapState,
  type EndOfCallRatingState,
  type EndOfCallAction,
} from './end-of-call';
export {
  ACTION_ITEM_SERVER_EVENTS,
  type ActionItemServerEventMap,
  type ActionItemAssigneeRole,
  type ActionItemActorRole,
} from './action-item';
export {
  WALLET_EVENTS,
  type WalletEventMap,
  type WalletLens,
  type WalletRestingStateName,
} from './wallet';
export { SCHEDULE_EVENTS, type ScheduleEventMap } from './schedule';
// BAL-435 — the in-call surface's CLIENT family. ⚠ Deliberately separate from `./meeting`,
// which is SERVER-ONLY and must stay out of `AllEvents`.
export {
  MEETING_CALL_EVENTS,
  type MeetingCallEventMap,
  type MeetingCallLayout,
  type MeetingCallLayoutSource,
  type MeetingCallLeaveReason,
  type MeetingCallGrantRejectionReason,
  type MeetingCallDeviceKind,
} from './meeting-call';
// BAL-436 — the in-call SIDE PANEL's CLIENT family (People and Files). ⚠ Deliberately
// separate from `./guest`, which is SERVER-ONLY and must stay out of `AllEvents`.
export {
  MEETING_PANEL_EVENTS,
  type MeetingPanelEventMap,
  type MeetingPanelId,
  type MeetingPanelAdmissionDecision,
  type MeetingPanelDecisionOutcome,
  type MeetingPanelInviteOutcome,
  type MeetingPanelOutcome,
  type MeetingPanelFileOutcome,
  type MeetingPanelSizeBucket,
  type MeetingPanelMessageOutcome,
  type MeetingPanelReactionEmoji,
} from './meeting-panel';
export {
  TRANSCRIPT_SERVER_EVENTS,
  type TranscriptServerEventMap,
  type TranscriptVenue,
} from './transcript';
// BAL-473 — the meeting-recording pipeline's SERVER-ONLY family (Daily cloud recording → Mux
// ingest → signed playback). See `./recording` for why: no vendor ids, no vendor error text.
export {
  RECORDING_SERVER_EVENTS,
  type RecordingServerEventMap,
  type RecordingTrigger,
  type RecordingFailureStage,
  type RecordingFailureReason,
} from './recording';
export {
  REVIEW_SERVER_EVENTS,
  type ReviewServerEventMap,
  type ReviewEngagementKind,
  type ReviewWriteProperties,
} from './review';
export {
  MEETING_SERVER_EVENTS,
  type MeetingServerEventMap,
  type MeetingBookingContextType,
} from './meeting';
export {
  GUEST_SERVER_EVENTS,
  type GuestServerEventMap,
  type GuestInviteEntryPoint,
  type GuestJoinMethod,
} from './guest';
export {
  AVAILABILITY_EVENTS,
  type AvailabilityEventMap,
  type AvailabilityConflictResolution,
  AVAILABILITY_SERVER_EVENTS,
  type AvailabilityServerEventMap,
} from './availability';
export {
  BOOKING_EVENTS,
  type BookingEventMap,
  type BookingSource,
  type BookingEntryMode,
  type BookingAbandonStep,
  // BAL-411 CONSIDER item — was absent from this allowlist, unlike its sibling
  // `AvailabilityConflictResolution`.
  type RescheduleProposalOutcome,
} from './booking';
// BAL-494 / ADR-1053 — SERVER-ONLY: the switch is decided and dispatched entirely in
// `switchWorkspace()` (apps/web); no browser code ever emits this event.
export { WORKSPACE_SERVER_EVENTS, type WorkspaceServerEventMap } from './workspace';
// BAL-495 / ADR-1053 — the nav registry's CLIENT event, shared by the sidebar today and by
// BAL-501's bottom tabs / BAL-503's ⌘K palette later. `NAV_ITEM_KEYS` / `NAV_SURFACES` are the
// canonical tuples `apps/web`'s `nav-registry.ts` derives its `NavItemKey` type from.
export {
  NAV_EVENTS,
  type NavEventMap,
  NAV_ITEM_KEYS,
  type NavItemKey,
  NAV_SURFACES,
  type NavSurface,
} from './nav';
// BAL-502 / ADR-1053 — the public marketing chrome's CLIENT event family. Deliberately
// separate from `./nav`, which is the DASHBOARD nav registry's server-resolved family.
export {
  MARKETING_EVENTS,
  type MarketingEventMap,
  MARKETING_NAV_LINKS,
  type MarketingNavLink,
  MARKETING_SURFACES,
  type MarketingSurface,
} from './marketing';
