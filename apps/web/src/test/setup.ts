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
vi.mock('@/lib/analytics', () => ({
  analytics: {
    identify: vi.fn(),
    track: vi.fn(),
    page: vi.fn(),
    reset: vi.fn(),
  },
  track: vi.fn(),
  AUTH_EVENTS: {
    MODAL_OPENED: 'auth_modal_opened',
    METHOD_SELECTED: 'auth_method_selected',
    LOGIN_COMPLETED: 'auth_login_completed',
    LOGIN_FAILED: 'auth_login_failed',
    SIGNUP_COMPLETED: 'auth_signup_completed',
    LOGOUT_COMPLETED: 'auth_logout_completed',
    PASSWORD_RESET_REQUESTED: 'auth_password_reset_requested',
    OAUTH_REDIRECT_STARTED: 'auth_oauth_redirect_started',
  },
  ONBOARDING_EVENTS: {
    STEP_VIEWED: 'onboarding_step_viewed',
    STEP_COMPLETED: 'onboarding_step_completed',
    COMPLETED: 'onboarding_completed',
  },
  initAnalytics: vi.fn(),
}));

// Cleanup after each test
afterEach(() => {
  cleanup();
});
