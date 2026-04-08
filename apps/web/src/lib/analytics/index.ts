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
} from '@balo/analytics/client';

export type { AllEvents, EventName } from '@balo/analytics/client';
