import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { track } from './track';
import { AUTH_EVENTS } from '../events/auth';

vi.mock('./client', () => ({
  analytics: {
    track: vi.fn(),
  },
}));

describe('track', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is a no-op when window is undefined', async () => {
    const { analytics } = await import('./client');

    track(AUTH_EVENTS.LOGIN_COMPLETED, {
      method: 'email',
      is_returning_user: true,
    });

    expect(analytics.track).not.toHaveBeenCalled();
  });

  it('calls analytics.track with event and properties in browser', async () => {
    const { analytics } = await import('./client');

    // Simulate browser environment
    globalThis.window = {} as typeof globalThis.window;

    track(AUTH_EVENTS.LOGIN_COMPLETED, {
      method: 'email',
      is_returning_user: true,
    });

    expect(analytics.track).toHaveBeenCalledWith(AUTH_EVENTS.LOGIN_COMPLETED, {
      method: 'email',
      is_returning_user: true,
    });

    // @ts-expect-error — cleanup
    delete globalThis.window;
  });
});
