// Environment-neutral global mocks (structured logger, analytics, etc.). Loaded first by both web
// test projects: `web` (jsdom, `.test.tsx`) and `web-node` (node, `.test.ts`).
import { vi } from 'vitest';

// Silence structured logger in tests — all auth actions and server code import this.
// Auto-mock avoids adding vi.mock('@/lib/logging') to every test file.
vi.mock('@/lib/logging', () => ({
  log: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() },
  // ⚠ THE REAL IMPLEMENTATION, NOT `vi.fn()`. `errorMessage` is a pure `unknown → string`
  // helper whose OUTPUT is what production code writes into log payloads, and several suites
  // assert on that exact payload. A `vi.fn()` returning `undefined` would make those
  // assertions pass vacuously, or fail for a reason unrelated to the behaviour under test.
  // Kept in lockstep with `@/lib/logging`'s version, which deliberately avoids `String(obj)`
  // (that yields the useless '[object Object]').
  errorMessage: (err: unknown): string => {
    if (err instanceof Error) return err.message;
    if (typeof err === 'string') return err;
    try {
      return JSON.stringify(err) ?? 'Unknown error';
    } catch {
      return 'Unknown error';
    }
  },
  getContext: vi.fn(),
  withContext: vi.fn(),
  requestContext: {},
}));

// Silence analytics in tests — prevent PostHog calls and provide stable mocks.
// Import real constants so the mock stays in sync with source.
vi.mock('@/lib/analytics', async () => {
  const events = await import('@balo/analytics/events');
  return {
    analytics: { identify: vi.fn(), track: vi.fn(), page: vi.fn(), reset: vi.fn() },
    track: vi.fn(),
    // BAL-529 §A — the reporter-installer seam. ⚠ WITHOUT THIS LINE any test whose module graph
    // reaches `PostHogProvider` throws on an undefined constant (memory
    // `reference_web_analytics_test_mock_export_list`).
    setAnalyticsErrorReporter: vi.fn(),
    AUTH_EVENTS: events.AUTH_EVENTS,
    ONBOARDING_EVENTS: events.ONBOARDING_EVENTS,
    EXPERT_EVENTS: events.EXPERT_EVENTS,
    EXPERT_SETUP_EVENTS: events.EXPERT_SETUP_EVENTS,
    EXPERT_RATE_EVENTS: events.EXPERT_RATE_EVENTS,
    EXPERT_PAYOUT_EVENTS: events.EXPERT_PAYOUT_EVENTS,
    AVATAR_EVENTS: events.AVATAR_EVENTS,
    PHONE_EVENTS: events.PHONE_EVENTS,
    CALENDAR_EVENTS: events.CALENDAR_EVENTS,
    SEARCH_EVENTS: events.SEARCH_EVENTS,
    EXPERT_PROFILE_EVENTS: events.EXPERT_PROFILE_EVENTS,
    PROJECT_EVENTS: events.PROJECT_EVENTS,
    CONVERSATION_EVENTS: events.CONVERSATION_EVENTS,
    // BAL-283 — the canonical call-surface tuple. ⚠ WITHOUT THIS LINE any test whose module
    // graph reaches a Server Action that derives its Zod enum from it throws on an undefined
    // constant (memory `reference_web_analytics_test_mock_export_list`).
    CONVERSATION_CALL_SURFACES: events.CONVERSATION_CALL_SURFACES,
    PROJECTS_INBOX_EVENTS: events.PROJECTS_INBOX_EVENTS,
    BILLING_EVENTS: events.BILLING_EVENTS,
    ADMIN_ENGAGEMENTS_EVENTS: events.ADMIN_ENGAGEMENTS_EVENTS,
    ENGAGEMENT_EVENTS: events.ENGAGEMENT_EVENTS,
    DOMAIN_JOIN_EVENTS: events.DOMAIN_JOIN_EVENTS,
    EXPERT_AGENCY_EVENTS: events.EXPERT_AGENCY_EVENTS,
    ONBOARDING_REMINDER_EVENTS: events.ONBOARDING_REMINDER_EVENTS,
    CREDIT_EVENTS: events.CREDIT_EVENTS,
    PROMO_EVENTS: events.PROMO_EVENTS,
    SESSION_EVENTS: events.SESSION_EVENTS,
    CASE_BILLING_EVENTS: events.CASE_BILLING_EVENTS,
    RECAP_EVENTS: events.RECAP_EVENTS,
    // ⚠ CLIENT ONLY. `END_OF_CALL_SERVER_EVENTS` must never join this list — this mock stands
    // in for `@/lib/analytics`, the client barrel (memory
    // `reference_web_analytics_test_mock_export_list`).
    END_OF_CALL_EVENTS: events.END_OF_CALL_EVENTS,
    // BAL-587 — the in-app rating card's CLIENT event. `REVIEW_SERVER_EVENTS` must never join
    // this list — this mock stands in for `@/lib/analytics`, the client barrel.
    REVIEW_EVENTS: events.REVIEW_EVENTS,
    WALLET_EVENTS: events.WALLET_EVENTS,
    SCHEDULE_EVENTS: events.SCHEDULE_EVENTS,
    MEETING_CALL_EVENTS: events.MEETING_CALL_EVENTS,
    // BAL-436 — the in-call side panel's CLIENT family. ⚠ WITHOUT THIS LINE every panel test
    // throws on an undefined constant (memory `reference_web_analytics_test_mock_export_list`).
    // ⚠ `GUEST_SERVER_EVENTS` must NEVER join this list — it is server-only.
    MEETING_PANEL_EVENTS: events.MEETING_PANEL_EVENTS,
    // Availability CLIENT family — BAL-416's conflict warnings AND BAL-236's slot picker.
    // ⚠ WITHOUT THIS LINE every availability test throws on an undefined constant
    // (memory `reference_web_analytics_test_mock_export_list`). ⚠ `AVAILABILITY_SERVER_EVENTS`
    // must NEVER join this list — it is server-only.
    AVAILABILITY_EVENTS: events.AVAILABILITY_EVENTS,
    // BAL-400 — the case-booking flow's CLIENT family. ⚠ WITHOUT THIS LINE every booking
    // component test throws on an undefined constant (memory
    // `reference_web_analytics_test_mock_export_list`).
    BOOKING_EVENTS: events.BOOKING_EVENTS,
    // BAL-495 — the nav registry's CLIENT event + canonical key/surface tuples. ⚠ WITHOUT THIS
    // LINE every test whose module graph reaches the sidebar (or `use-nav-item-tracking`)
    // throws on an undefined constant (memory `reference_web_analytics_test_mock_export_list`).
    NAV_EVENTS: events.NAV_EVENTS,
    NAV_ITEM_KEYS: events.NAV_ITEM_KEYS,
    NAV_SURFACES: events.NAV_SURFACES,
    // BAL-496 — the workspace switcher's CLIENT event. ⚠ WITHOUT THIS LINE every test whose
    // module graph reaches the sidebar throws on an undefined constant (memory
    // `reference_web_analytics_test_mock_export_list`). ⚠ `WORKSPACE_SERVER_EVENTS` must NEVER
    // join this list — this mock stands in for `@/lib/analytics`, the CLIENT barrel.
    WORKSPACE_EVENTS: events.WORKSPACE_EVENTS,
    // BAL-502 — the marketing chrome's CLIENT event + canonical link/surface tuples. ⚠ WITHOUT
    // THIS LINE every test whose module graph reaches the marketing header or mobile menu
    // throws on an undefined constant (memory `reference_web_analytics_test_mock_export_list`).
    MARKETING_EVENTS: events.MARKETING_EVENTS,
    MARKETING_NAV_LINKS: events.MARKETING_NAV_LINKS,
    MARKETING_SURFACES: events.MARKETING_SURFACES,
    // BAL-493 — the marketing HOME PAGE's CLIENT event + its five vocabulary tuples. ⚠ WITHOUT
    // THESE LINES every test whose module graph reaches the home page (or
    // `use-marketing-home-tracking`) throws on an undefined constant (memory
    // `reference_web_analytics_test_mock_export_list`).
    MARKETING_HOME_EVENTS: events.MARKETING_HOME_EVENTS,
    MARKETING_HOME_SECTIONS: events.MARKETING_HOME_SECTIONS,
    MARKETING_HOME_CTA_PLACEMENTS: events.MARKETING_HOME_CTA_PLACEMENTS,
    MARKETING_HOME_BENCH_ROWS: events.MARKETING_HOME_BENCH_ROWS,
    MARKETING_HOME_PRODUCT_SOURCES: events.MARKETING_HOME_PRODUCT_SOURCES,
    MARKETING_HOME_SPOTLIGHT_ACTIONS: events.MARKETING_HOME_SPOTLIGHT_ACTIONS,
    // BAL-503 — the client Settings surface's CLIENT event + canonical section tuple. ⚠ WITHOUT
    // THIS LINE every test whose module graph reaches the Settings tab bar throws on an
    // undefined constant (memory `reference_web_analytics_test_mock_export_list`).
    SETTINGS_EVENTS: events.SETTINGS_EVENTS,
    SETTINGS_SECTIONS: events.SETTINGS_SECTIONS,
    // BAL-500 — the ⌘K command palette's CLIENT event + canonical method/type tuples. ⚠ WITHOUT
    // THIS LINE every test whose module graph reaches the palette (incl. top-nav.test.tsx,
    // sidebar.test.tsx, (dashboard)/layout.test.tsx) throws on an undefined constant (memory
    // `reference_web_analytics_test_mock_export_list`).
    COMMAND_PALETTE_EVENTS: events.COMMAND_PALETTE_EVENTS,
    COMMAND_PALETTE_OPEN_METHODS: events.COMMAND_PALETTE_OPEN_METHODS,
    COMMAND_PALETTE_ACTION_TYPES: events.COMMAND_PALETTE_ACTION_TYPES,
    // BAL-597 — the public help centre's CLIENT event, vocabulary tuples and comment cap. ⚠ WITHOUT
    // THESE LINES every test whose module graph reaches a help component throws on an undefined
    // constant (memory `reference_web_analytics_test_mock_export_list`).
    HELP_EVENTS: events.HELP_EVENTS,
    HELP_AUDIENCES: events.HELP_AUDIENCES,
    HELP_ARTICLE_SOURCES: events.HELP_ARTICLE_SOURCES,
    HELP_FEEDBACK_COMMENT_MAX: events.HELP_FEEDBACK_COMMENT_MAX,
    // BAL-529 §D — the Stripe redirect-return family's event constant + its two vocabularies.
    // ⚠ WITHOUT THESE LINES every test whose module graph reaches
    // `useSetupIntentRedirectReturn` throws on an undefined constant (memory
    // `reference_web_analytics_test_mock_export_list`).
    STRIPE_REDIRECT_EVENTS: events.STRIPE_REDIRECT_EVENTS,
    STRIPE_REDIRECT_SURFACES: events.STRIPE_REDIRECT_SURFACES,
    STRIPE_REDIRECT_UNBOUND_REASONS: events.STRIPE_REDIRECT_UNBOUND_REASONS,
    // BAL-551 — the admin lookup surface's CLIENT event constant. ⚠ WITHOUT THIS LINE every test
    // whose module graph reaches the lookup shell throws on an undefined constant (memory
    // `reference_web_analytics_test_mock_export_list`).
    ADMIN_LOOKUP_EVENTS: events.ADMIN_LOOKUP_EVENTS,
    // BAL-548 / ADR-1055 — the admin pending-actions queue's CLIENT event constant. ⚠ WITHOUT
    // THIS LINE every test whose module graph reaches `AdminQueueAnalytics` or `AlertRow`
    // throws on an undefined constant (memory `reference_web_analytics_test_mock_export_list`).
    ADMIN_ALERTS_EVENTS: events.ADMIN_ALERTS_EVENTS,
    // BAL-549 — the admin expert-applications surface's CLIENT event constant. ⚠ WITHOUT THIS
    // LINE every test whose module graph reaches the applications list/review islands throws on
    // an undefined constant (memory `reference_web_analytics_test_mock_export_list`).
    ADMIN_APPLICATIONS_EVENTS: events.ADMIN_APPLICATIONS_EVENTS,
    // BAL-550 — the `/admin/health/capture` lens's CLIENT event constant. ⚠ WITHOUT THIS LINE
    // every test whose module graph reaches `CaptureHealthAnalytics` or `RedriveSheet` throws
    // on an undefined constant (memory `reference_web_analytics_test_mock_export_list`).
    ADMIN_CAPTURE_HEALTH_EVENTS: events.ADMIN_CAPTURE_HEALTH_EVENTS,
    // BAL-566 / BAL-600 — the dashboard "Up next" card's and "Your move" rail's CLIENT event
    // constant. ⚠ WITHOUT THIS LINE every test whose module graph reaches `UpNextCard` or
    // `YourMove` throws on an undefined constant (memory `reference_web_analytics_test_mock_export_list`).
    DASHBOARD_EVENTS: events.DASHBOARD_EVENTS,
    // BAL-589 — the "Convert a case to a project" AI brief's CLIENT event constant. ⚠ WITHOUT
    // THIS LINE every test whose module graph reaches `useCaseBriefFlow` throws on an undefined
    // constant (memory `reference_web_analytics_test_mock_export_list`).
    CASE_BRIEF_EVENTS: events.CASE_BRIEF_EVENTS,
    initAnalytics: vi.fn(),
    syncSessionReplayToRoute: vi.fn(),
  };
});
