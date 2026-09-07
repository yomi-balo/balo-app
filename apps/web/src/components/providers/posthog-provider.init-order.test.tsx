import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';

/**
 * FIX ROUND 1 F3 (security S3) — the REAL ordering proof, deliberately kept in its OWN file.
 *
 * `posthog-provider.test.tsx` (and every other web test) relies on the global mock in
 * `apps/web/src/test/setup.ts`, which stubs BOTH `track` and `initAnalytics` as bare `vi.fn()`s.
 * That is fine for asserting WHAT was called, but it can prove NOTHING about the ORDER two
 * independent mocks fire in relative to `posthog.init`/`posthog.capture` — a mocked
 * `initAnalytics` never touches `posthog-js` at all, so a test built on it would pass whether
 * the real fix was applied or not.
 *
 * This file `vi.unmock`s `@/lib/analytics`, so importing it resolves to the REAL
 * `packages/analytics/src/client/client.ts`, which calls the REAL (here, spied) `posthog-js`.
 * That lets this test observe the actual sequence a browser would produce: does `posthog.init`
 * run before `posthog.capture` when a component mounted BELOW `PostHogProvider` calls `track()`
 * from its own mount effect — the exact shape `useSetupIntentRedirectReturn`'s §D unbound-return
 * diagnostic uses.
 */
vi.unmock('@/lib/analytics');

const mockPosthogInit = vi.fn();
const mockPosthogCapture = vi.fn();
/**
 * ⚠ MOCKED BY RELATIVE FILESYSTEM PATH, NOT THE BARE SPECIFIER `'posthog-js'`. `apps/web`'s
 * own `package.json` does not list `posthog-js` as a dependency — it only ever reaches it
 * TRANSITIVELY through `@balo/analytics`, which resolves it fine at build/runtime (Node/Vite
 * resolution walks up from `packages/analytics/src/client/client.ts`'s OWN location, which does
 * have `posthog-js` in `packages/analytics/node_modules`). But `vi.mock('posthog-js', …)`
 * registered from THIS test file resolves relative to THIS file's location, which has no such
 * path — confirmed empirically: that bare-specifier form of this mock is silently never hit, and
 * `client.ts` ends up calling the REAL (uninitialized, no-op) posthog-js instead, which would
 * make this whole test pass or fail for the wrong reason. The relative path below reaches the
 * exact same resolved package `@balo/analytics/client` imports, so the mock lands correctly.
 */
vi.mock('../../../../../packages/analytics/node_modules/posthog-js', () => ({
  default: {
    init: mockPosthogInit,
    capture: mockPosthogCapture,
    identify: vi.fn(),
    reset: vi.fn(),
  },
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}));

const PREV_POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;

describe('BAL-529 fix-round-1 F3 — analytics initializes before a descendant effect can track()', () => {
  beforeEach(() => {
    vi.resetModules();
    mockPosthogInit.mockClear();
    mockPosthogCapture.mockClear();
    globalThis.history.replaceState(
      {},
      '',
      '/settings/billing?setup_intent=seti_x&setup_intent_client_secret=seti_x_secret'
    );
    globalThis.sessionStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (PREV_POSTHOG_KEY === undefined) {
      delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    } else {
      process.env.NEXT_PUBLIC_POSTHOG_KEY = PREV_POSTHOG_KEY;
    }
  });

  it('posthog.init has already run by the time a nested hook effect calls track() — proved WITHOUT mocking initAnalytics', async () => {
    // `initAnalytics()` reads `process.env.NEXT_PUBLIC_POSTHOG_KEY` at MODULE EVALUATION time
    // (that is the whole point of F3's fix), so the env var must be set BEFORE the dynamic
    // import below resolves — a static top-of-file import would already have run by the time any
    // of this test's own statements execute (ES module import hoisting), which is exactly why
    // this test uses `await import(...)` rather than a static import.
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_test_ordering');

    const { PostHogProvider } = await import('./posthog-provider');
    const { useSetupIntentRedirectReturn } =
      await import('@/lib/stripe/use-setup-intent-redirect-return');

    function Probe(): null {
      useSetupIntentRedirectReturn({
        retryMessage: 'retry',
        surface: 'settings',
        onStarted: () => undefined,
        onSucceeded: () => undefined,
        onProcessing: () => undefined,
        onProcessingTimeout: () => undefined,
        onFailed: () => undefined,
      });
      return null;
    }

    render(
      <PostHogProvider>
        <Probe />
      </PostHogProvider>
    );

    // The hook's mount effect ran (child-first, ahead of the provider's own effects) and found
    // an unbound return, so it called `track()` exactly once — which, unmocked, reaches
    // `posthog.capture` for real.
    expect(mockPosthogCapture).toHaveBeenCalledTimes(1);
    expect(mockPosthogInit).toHaveBeenCalledTimes(1);

    const [initOrder] = mockPosthogInit.mock.invocationCallOrder;
    const [captureOrder] = mockPosthogCapture.mock.invocationCallOrder;
    if (initOrder === undefined || captureOrder === undefined) {
      throw new Error('expected both posthog.init and posthog.capture to have run');
    }
    // THE PROOF: init committed before capture, despite capture originating from a mount effect
    // on a DESCENDANT of PostHogProvider, which React flushes BEFORE the provider's own effect.
    expect(initOrder).toBeLessThan(captureOrder);
  });
});
