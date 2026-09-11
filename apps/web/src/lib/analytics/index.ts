// Re-export from shared analytics package.
// Keeps existing @/lib/analytics imports working across the web app.
export {
  initAnalytics,
  analytics,
  track,
  // BAL-529 §A — the browser-side analytics error reporter seam. Installed by
  // `PostHogProvider` with a Sentry-backed reporter before `initAnalytics()` runs.
  setAnalyticsErrorReporter,
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
  /** BAL-493 — the marketing HOME PAGE's event constant + its five vocabulary tuples. */
  MARKETING_HOME_EVENTS,
  MARKETING_HOME_SECTIONS,
  MARKETING_HOME_CTA_PLACEMENTS,
  MARKETING_HOME_BENCH_ROWS,
  MARKETING_HOME_PRODUCT_SOURCES,
  MARKETING_HOME_SPOTLIGHT_ACTIONS,
  /** BAL-503 — the client Settings surface's event constant + canonical section tuple. */
  SETTINGS_EVENTS,
  SETTINGS_SECTIONS,
  /** BAL-500 — the ⌘K command palette's event constant + canonical method/type tuples. */
  COMMAND_PALETTE_EVENTS,
  COMMAND_PALETTE_OPEN_METHODS,
  COMMAND_PALETTE_ACTION_TYPES,
  /** BAL-529 §D — the Stripe redirect-return family's event constant + its two vocabularies. */
  STRIPE_REDIRECT_EVENTS,
  STRIPE_REDIRECT_SURFACES,
  STRIPE_REDIRECT_UNBOUND_REASONS,
  /** BAL-551 — the admin lookup surface's event constant (one search box across entity types). */
  ADMIN_LOOKUP_EVENTS,
  /** BAL-548 / ADR-1055 — the admin pending-actions queue's event constant. */
  ADMIN_ALERTS_EVENTS,
} from '@balo/analytics/client';

export type {
  AllEvents,
  EventName,
  // BAL-529 §A — the reporter callback signature `PostHogProvider` implements.
  AnalyticsErrorReporter,
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
  /** BAL-493 — the marketing home page's event payload and its five vocabularies. */
  MarketingHomeEventMap,
  MarketingHomeSection,
  MarketingHomeCtaPlacement,
  MarketingHomeBenchRow,
  MarketingHomeProductSource,
  MarketingHomeSpotlightAction,
  /** BAL-503 — the client Settings surface's event payload and section vocabulary. */
  SettingsEventMap,
  SettingsSection,
  /** BAL-500 — the ⌘K command palette's event payload and method/type vocabularies. */
  CommandPaletteEventMap,
  CommandPaletteOpenMethod,
  CommandPaletteActionType,
  /** BAL-529 §D — the Stripe redirect-return family's event payload and its two vocabularies. */
  StripeRedirectEventMap,
  StripeRedirectSurface,
  StripeRedirectUnboundReason,
  /** BAL-551 — the admin lookup surface's event payload and its matched-by vocabulary. */
  AdminLookupEventMap,
  AdminLookupMatchedBy,
  /** BAL-548 / ADR-1055 — the admin pending-actions queue's event payload and its two
   *  vocabularies. */
  AdminAlertsEventMap,
  AdminAlertAgeBucket,
  AdminAlertQueueFilter,
} from '@balo/analytics/client';
