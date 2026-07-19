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
    initAnalytics: vi.fn(),
  };
});

// Cleanup after each test
afterEach(() => {
  cleanup();
});
