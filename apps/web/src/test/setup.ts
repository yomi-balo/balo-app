import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, expect, vi } from 'vitest';
import { toHaveNoViolations } from 'jest-axe';

// Register the jest-axe matcher once, globally — component tests call
// `expect(await axe(container)).toHaveNoViolations()` without per-file setup.
expect.extend(toHaveNoViolations);

// JSDOM lacks ResizeObserver, which Radix primitives (Slider, Popover) rely on.
// Provide a no-op stub so those components mount in component tests.
if (!('ResizeObserver' in globalThis)) {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

// JSDOM lacks IntersectionObserver, which the expert-profile scroll-spy
// (expert-profile-client) and section-view analytics (expert-profile-analytics)
// rely on. Provide a no-op stub so the observer-setup effects run (rather than
// hitting their `typeof IntersectionObserver === 'undefined'` early-return).
if (!('IntersectionObserver' in globalThis)) {
  class IntersectionObserverStub {
    readonly root: Element | null = null;
    readonly rootMargin: string = '';
    readonly thresholds: ReadonlyArray<number> = [];
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  globalThis.IntersectionObserver =
    IntersectionObserverStub as unknown as typeof IntersectionObserver;
}

// JSDOM lacks Element.prototype.scrollIntoView, which the StickyNav smooth-jump
// (via expert-profile-client's handleJump) calls. Stub it so clicking a nav tab
// in component tests doesn't throw.
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {};
}

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
    // BAL-500 — the ⌘K command palette's CLIENT event + canonical method/type tuples. ⚠ WITHOUT
    // THIS LINE every test whose module graph reaches the palette (incl. top-nav.test.tsx,
    // sidebar.test.tsx, (dashboard)/layout.test.tsx) throws on an undefined constant (memory
    // `reference_web_analytics_test_mock_export_list`).
    COMMAND_PALETTE_EVENTS: events.COMMAND_PALETTE_EVENTS,
    COMMAND_PALETTE_OPEN_METHODS: events.COMMAND_PALETTE_OPEN_METHODS,
    COMMAND_PALETTE_ACTION_TYPES: events.COMMAND_PALETTE_ACTION_TYPES,
    initAnalytics: vi.fn(),
  };
});

// Cleanup after each test
afterEach(() => {
  cleanup();
});
