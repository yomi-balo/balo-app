import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from '@/test/utils';
import { setAnalyticsErrorReporter, analytics, initAnalytics } from '@/lib/analytics';
import { PostHogProvider } from './posthog-provider';

const mockCaptureException = vi.fn();
vi.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

describe('PostHogProvider', () => {
  afterEach(() => {
    vi.mocked(analytics.identify).mockClear();
    mockCaptureException.mockClear();
  });

  /**
   * FIX ROUND 1 F3 — `setAnalyticsErrorReporter` + `initAnalytics` moved to MODULE SCOPE
   * (see `posthog-provider.tsx`'s docblock), so they run exactly ONCE, the moment this test
   * FILE's `import { PostHogProvider } from './posthog-provider'` above evaluates — before any
   * `it()` block runs, and independent of how many times `<PostHogProvider>` is rendered below.
   * These two mocks are therefore asserted WITHOUT `mockClear()` in `afterEach`: clearing them
   * would just prove they are not called again on a second render, which is not the point — the
   * point (mutation-proved for real ordering, without this mock, in
   * `posthog-provider.init-order.test.tsx`) is that they run before ANY descendant effect.
   */
  it('installs a Sentry-backed analytics error reporter at module load, exactly once', () => {
    expect(setAnalyticsErrorReporter).toHaveBeenCalledTimes(1);

    // Drive the installed reporter directly: this is what makes deleting the wiring in
    // `posthog-provider.tsx` fail the test (mutation-provable).
    const [reporterCall] = vi.mocked(setAnalyticsErrorReporter).mock.calls;
    if (reporterCall === undefined) throw new Error('reporter was never installed');
    const [reporter] = reporterCall;
    expect(reporter).toBeTypeOf('function');

    const error = new Error('posthog capture failed');
    reporter?.(error, { method: 'track' });

    expect(mockCaptureException).toHaveBeenCalledWith(error, {
      tags: { analytics_method: 'track' },
    });
  });

  it('installs the reporter BEFORE initAnalytics runs', () => {
    const [setCall] = vi.mocked(setAnalyticsErrorReporter).mock.invocationCallOrder;
    const [initCall] = vi.mocked(initAnalytics).mock.invocationCallOrder;
    if (setCall === undefined || initCall === undefined) {
      throw new Error('expected both setAnalyticsErrorReporter and initAnalytics to be called');
    }
    expect(setCall).toBeLessThan(initCall);
  });

  it('calls initAnalytics exactly once, regardless of how many times the provider renders', () => {
    render(<PostHogProvider>{null}</PostHogProvider>);
    render(<PostHogProvider>{null}</PostHogProvider>);

    expect(initAnalytics).toHaveBeenCalledTimes(1);
  });

  it('identifies the user when userId + traits are present', () => {
    render(
      <PostHogProvider userId="user-1" userTraitsJson={JSON.stringify({ email: 'a@b.com' })}>
        {null}
      </PostHogProvider>
    );

    expect(analytics.identify).toHaveBeenCalledWith('user-1', { email: 'a@b.com' });
  });

  it('does not identify when userId is absent', () => {
    render(<PostHogProvider>{null}</PostHogProvider>);

    expect(analytics.identify).not.toHaveBeenCalled();
  });
});
