export {
  getServerAnalytics,
  shutdownServerAnalytics,
  flushServerAnalytics,
} from './posthog-server';
export { trackServer } from './track-server';
export type { ServerEvents, ServerEventName } from '../types';
export { EXPERT_SERVER_EVENTS } from '../events/expert';
export { EXPERT_PAYOUT_SERVER_EVENTS } from '../events/expert-payouts';
export { NOTIFICATION_SERVER_EVENTS } from '../events/notifications';
export { CALENDAR_SERVER_EVENTS } from '../events/calendar';
export { SEARCH_SERVER_EVENTS } from '../events/search';
export { PROJECT_SERVER_EVENTS } from '../events/project';
export { BILLING_SERVER_EVENTS } from '../events/billing';
export { PARTY_DOMAIN_SERVER_EVENTS } from '../events/party-domains';
export { SIGNUP_DOMAIN_SERVER_EVENTS } from '../events/signup-domain';
export { ORG_INTENT_SERVER_EVENTS } from '../events/org-intent';
export { PARTY_JOIN_SERVER_EVENTS } from '../events/party-join';
export { ENGAGEMENT_SERVER_EVENTS } from '../events/engagement';
export { AUTH_SERVER_EVENTS } from '../events/auth';
export { ONBOARDING_REMINDER_SERVER_EVENTS } from '../events/onboarding-reminder';
export { CREDIT_SERVER_EVENTS } from '../events/credit';
export { PROMO_SERVER_EVENTS } from '../events/promo';
export { SESSION_SERVER_EVENTS } from '../events/session';
export { CASE_BILLING_SERVER_EVENTS } from '../events/case-billing';
// BAL-388 — the recap is a MIXED feature: its client half is exported from '../client'
// and its server half here. Both allowlists are load-bearing; neither package has a
// typecheck or test script that would notice a missing line.
export { RECAP_SERVER_EVENTS } from '../events/recap';
export type {
  RecapState,
  RecapLens,
  RecapContextType,
  RecapEntrySource,
  RecapResolvePromptVariant,
  RecapCta,
  // BAL-421 — `case_surface_viewed` is a SERVER event, so the case surface's RSC needs this
  // type to build its payload. `CaseSurfaceAction` is CLIENT-side and lives in '../client'.
  CaseSurfaceState,
} from '../events/recap';
export { ACTION_ITEM_SERVER_EVENTS } from '../events/action-item';
export type { ActionItemAssigneeRole, ActionItemActorRole } from '../events/action-item';
export { TRANSCRIPT_SERVER_EVENTS } from '../events/transcript';
export type { TranscriptVenue } from '../events/transcript';
// BAL-390 — SERVER-ONLY by design: `review_*` here always means the STAR RATING, and
// none of these three may be added to the client `@/lib/analytics` mock export list.
export { REVIEW_SERVER_EVENTS } from '../events/review';
// BAL-129 — THE STEP CLAUDE.md's analytics checklist OMITS: these are emitted from
// `apps/api`, which imports from `@balo/analytics/server` ONLY, so skipping this line makes
// them unimportable there. ⚠ THE ABSENCE STILL LANDS IN `apps/api`'s TYPECHECK, NOT THIS
// PACKAGE'S — the `typecheck` script added in BAL-132 compiles this package's own sources,
// which cannot notice a re-export that was never written.
export { MEETING_SERVER_EVENTS } from '../events/meeting';
export type { MeetingBookingContextType } from '../events/meeting';
// BAL-408 — THE SAME FOURTH STEP. `apps/api`'s guest routes and the `apps/web` join landing
// both import from `@balo/analytics/server`; omitting this line makes the constants
// unimportable and fails `apps/api`'s typecheck, not this package's.
export { GUEST_SERVER_EVENTS } from '../events/guest';
export type { GuestInviteEntryPoint, GuestJoinMethod } from '../events/guest';
export type { EngagementWorkspaceLens, EngagementWorkspaceEntry } from '../events/engagement';
