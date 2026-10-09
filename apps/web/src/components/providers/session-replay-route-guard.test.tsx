import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';

/**
 * End-to-end proof that a client-side route change reaches PostHog: real barrel, real
 * `client.ts`, spied `posthog-js`. Removing the guard, its effect, or the stop call fails this.
 */
vi.unmock('@/lib/analytics');

const mockInit = vi.fn();
const mockStop = vi.fn();
const mockStart = vi.fn();
// Mocked by relative filesystem path for the reason documented in
// `posthog-provider.init-order.test.tsx`.
vi.mock('../../../../../packages/analytics/node_modules/posthog-js', () => ({
  default: {
    init: mockInit,
    capture: vi.fn(),
    identify: vi.fn(),
    reset: vi.fn(),
    stopSessionRecording: mockStop,
    startSessionRecording: mockStart,
  },
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => globalThis.location.pathname,
}));

describe('SessionReplayRouteGuard', () => {
  beforeEach(() => {
    vi.resetModules();
    mockInit.mockClear();
    mockStop.mockClear();
    mockStart.mockClear();
    globalThis.history.replaceState({}, '', '/');
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_test_key');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('stops replay on entering a staff surface and resumes on leaving it', async () => {
    const { PostHogProvider } = await import('./posthog-provider');
    const { rerender } = render(
      <PostHogProvider>
        <span>child</span>
      </PostHogProvider>
    );
    expect(mockStop).not.toHaveBeenCalled();

    globalThis.history.replaceState({}, '', '/admin/lookup');
    rerender(
      <PostHogProvider>
        <span>child</span>
      </PostHogProvider>
    );
    expect(mockStop).toHaveBeenCalledTimes(1);

    globalThis.history.replaceState({}, '', '/experts/dana');
    rerender(
      <PostHogProvider>
        <span>child</span>
      </PostHogProvider>
    );
    expect(mockStart).toHaveBeenCalledTimes(1);
  });
});
