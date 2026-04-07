import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

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
    initAnalytics: vi.fn(),
  };
});

// Cleanup after each test
afterEach(() => {
  cleanup();
});
