// Re-export from shared analytics package.
// Keeps existing @/lib/analytics imports working across the web app.
export {
  initAnalytics,
  analytics,
  track,
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
  /** BAL-283 — the canonical `['header','rail','nudge']` tuple the Zod enums derive from. */
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
  /** BAL-436 — the in-call side panel (People and Files). */
  MEETING_PANEL_EVENTS,
  /** Availability CLIENT family — BAL-416's conflict warning + BAL-236's slot picker. */
  AVAILABILITY_EVENTS,
  /** BAL-400 — the case-booking flow. All eight are client events. */
  BOOKING_EVENTS,
  /** BAL-495 — the nav registry's event constant + canonical key/surface tuples. */
  NAV_EVENTS,
  NAV_ITEM_KEYS,
  NAV_SURFACES,
  /** BAL-496 — the switcher's CLIENT event. ⚠ `WORKSPACE_SERVER_EVENTS` must NEVER join this
   *  list — it is server-only. */
  WORKSPACE_EVENTS,
  /** BAL-502 — the marketing chrome's event constant + canonical link/surface tuples. */
  MARKETING_EVENTS,
  MARKETING_NAV_LINKS,
  MARKETING_SURFACES,
  /** BAL-500 — the ⌘K command palette's event constant + canonical method/type tuples. */
  COMMAND_PALETTE_EVENTS,
  COMMAND_PALETTE_OPEN_METHODS,
  COMMAND_PALETTE_ACTION_TYPES,
} from '@balo/analytics/client';

export type {
  AllEvents,
  EventName,
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
  AdminEngagementsFilter,
  MeetingCallLayout,
  MeetingCallLayoutSource,
  MeetingCallLeaveReason,
  MeetingCallGrantRejectionReason,
  MeetingCallDeviceKind,
  /** BAL-436 — the side panel's outcome vocabularies, named by the panel and its actions. */
  MeetingPanelId,
  MeetingPanelAdmissionDecision,
  MeetingPanelDecisionOutcome,
  MeetingPanelInviteOutcome,
  MeetingPanelOutcome,
  MeetingPanelFileOutcome,
  MeetingPanelSizeBucket,
  MeetingPanelMessageOutcome,
  MeetingPanelReactionEmoji,
  /** BAL-421 — annotates the case surface's client action handlers. */
  CaseSurfaceAction,
  /** BAL-416 — the time-off conflict warning's client outcome vocabulary. */
  AvailabilityConflictResolution,
  /** BAL-400 — the case-booking flow's client vocabulary. */
  BookingEventMap,
  BookingSource,
  BookingEntryMode,
  BookingAbandonStep,
  /** BAL-411 CONSIDER item — the reschedule-proposal answer vocabulary. */
  RescheduleProposalOutcome,
  /** BAL-495 — the nav registry's event payload and key/surface vocabularies. */
  NavEventMap,
  NavItemKey,
  NavSurface,
  /** BAL-496 — the workspace switcher's client event payload. */
  WorkspaceEventMap,
  /** BAL-502 — the marketing chrome's event payload and link/surface vocabularies. */
  MarketingEventMap,
  MarketingNavLink,
  MarketingSurface,
  /** BAL-500 — the ⌘K command palette's event payload and method/type vocabularies. */
  CommandPaletteEventMap,
  CommandPaletteOpenMethod,
  CommandPaletteActionType,
} from '@balo/analytics/client';
