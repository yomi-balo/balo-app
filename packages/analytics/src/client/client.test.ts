import { describe, it, expect, vi, afterEach } from 'vitest';
import type { CaptureResult } from 'posthog-js';

const mockCapture = vi.fn();
const mockIdentify = vi.fn();
const mockReset = vi.fn();
const mockInit = vi.fn();
const mockStopSessionRecording = vi.fn();
const mockStartSessionRecording = vi.fn();

vi.mock('posthog-js', () => ({
  default: {
    identify: mockIdentify,
    capture: mockCapture,
    reset: mockReset,
    init: mockInit,
    stopSessionRecording: mockStopSessionRecording,
    startSessionRecording: mockStartSessionRecording,
  },
}));

const { sanitizeAnalyticsEvent, analytics, initAnalytics } = await import('./client');
const { setAnalyticsErrorReporter } = await import('./error-reporter');

function makeEvent(properties: Record<string, unknown>): CaptureResult {
  return {
    uuid: 'evt-1',
    event: '$pageview',
    properties: properties as CaptureResult['properties'],
  };
}

describe('sanitizeAnalyticsEvent', () => {
  it('redacts the token in $current_url, $pathname, and $referrer', () => {
    const result = sanitizeAnalyticsEvent(
      makeEvent({
        $current_url: 'https://balo.expert/shared/proposals/secretTok?x=1',
        $pathname: '/shared/proposals/secretTok',
        $referrer: 'https://balo.expert/shared/proposals/secretTok',
      })
    );

    expect(result?.properties.$current_url).toBe(
      'https://balo.expert/shared/proposals/[redacted]?x=1'
    );
    expect(result?.properties.$pathname).toBe('/shared/proposals/[redacted]');
    expect(result?.properties.$referrer).toBe('https://balo.expert/shared/proposals/[redacted]');
  });

  it('leaves a normal (non-secret) URL untouched', () => {
    const result = sanitizeAnalyticsEvent(
      makeEvent({ $current_url: 'https://balo.expert/experts/dana', $pathname: '/experts/dana' })
    );
    expect(result?.properties.$current_url).toBe('https://balo.expert/experts/dana');
    expect(result?.properties.$pathname).toBe('/experts/dana');
  });

  it('returns null when the event is null (never throws)', () => {
    expect(sanitizeAnalyticsEvent(null)).toBeNull();
  });

  it('ignores non-string URL properties', () => {
    const result = sanitizeAnalyticsEvent(makeEvent({ $current_url: undefined, other: 42 }));
    expect(result?.properties.other).toBe(42);
  });

  // ── FIX ROUND 1 F4 (security S1) — $session_entry_* and $set_once.$initial_* ──────────────
  describe('BAL-529 fix-round-1 F4 — $session_entry_* and $set_once.$initial_*', () => {
    it('redacts $session_entry_url / $session_entry_pathname / $session_entry_referrer', () => {
      const result = sanitizeAnalyticsEvent(
        makeEvent({
          $session_entry_url:
            'https://balo.expert/settings/billing?setup_intent_client_secret=seti_LIVE_secret',
          $session_entry_pathname: '/join/tok_9f',
          $session_entry_referrer: 'https://balo.expert/review/tok_9f',
        })
      );

      expect(result?.properties.$session_entry_url).toBe(
        'https://balo.expert/settings/billing?setup_intent_client_secret=[redacted]'
      );
      expect(result?.properties.$session_entry_pathname).toBe('/join/[redacted]');
      expect(result?.properties.$session_entry_referrer).toBe(
        'https://balo.expert/review/[redacted]'
      );
    });

    it('walks $set_once and redacts $initial_current_url / $initial_pathname / $initial_referrer', () => {
      const result = sanitizeAnalyticsEvent(
        makeEvent({
          $set_once: {
            $initial_current_url:
              'https://balo.expert/redeem?setup_intent=seti_abc&setup_intent_client_secret=seti_abc_secret',
            $initial_pathname: '/shared/proposals/tok_9f',
            $initial_referrer: 'https://balo.expert/join/tok_9f',
            $initial_utm_source: 'google', // an unrelated $set_once key must survive untouched
          },
        })
      );

      const setOnce = result?.properties.$set_once as Record<string, unknown>;
      expect(setOnce.$initial_current_url).toBe(
        'https://balo.expert/redeem?setup_intent=[redacted]&setup_intent_client_secret=[redacted]'
      );
      expect(setOnce.$initial_pathname).toBe('/shared/proposals/[redacted]');
      expect(setOnce.$initial_referrer).toBe('https://balo.expert/join/[redacted]');
      expect(setOnce.$initial_utm_source).toBe('google');
    });

    it('tolerates $set_once being absent, null, or not an object (never throws)', () => {
      expect(() => sanitizeAnalyticsEvent(makeEvent({ other: 1 }))).not.toThrow();
      expect(() => sanitizeAnalyticsEvent(makeEvent({ $set_once: null }))).not.toThrow();
      expect(() => sanitizeAnalyticsEvent(makeEvent({ $set_once: 'not-an-object' }))).not.toThrow();
    });

    it('an event carrying BOTH sinks together comes out fully redacted', () => {
      const result = sanitizeAnalyticsEvent(
        makeEvent({
          $session_entry_url:
            'https://balo.expert/settings/billing?setup_intent_client_secret=LIVE1',
          $set_once: {
            $initial_current_url: 'https://balo.expert/redeem?payment_intent_client_secret=LIVE2',
          },
        })
      );

      const output = JSON.stringify(result);
      expect(output).not.toContain('LIVE1');
      expect(output).not.toContain('LIVE2');
    });
  });
});

describe('analytics — BAL-529 §A guards (a throwing posthog call never escapes)', () => {
  afterEach(() => {
    setAnalyticsErrorReporter(null);
    mockCapture.mockReset();
    mockIdentify.mockReset();
    mockReset.mockReset();
  });

  it('identify: does not throw, and reports the failure', () => {
    const reporter = vi.fn();
    setAnalyticsErrorReporter(reporter);
    const error = new Error('boom');
    mockIdentify.mockImplementation(() => {
      throw error;
    });

    expect(() => analytics.identify('user-1', {})).not.toThrow();
    expect(reporter).toHaveBeenCalledWith(error, { method: 'identify' });
  });

  it('track: does not throw, and reports the failure', () => {
    const reporter = vi.fn();
    setAnalyticsErrorReporter(reporter);
    const error = new Error('boom');
    mockCapture.mockImplementation(() => {
      throw error;
    });

    expect(() => analytics.track('e', {})).not.toThrow();
    expect(reporter).toHaveBeenCalledWith(error, { method: 'track' });
  });

  it('page: does not throw, and reports the failure', () => {
    const reporter = vi.fn();
    setAnalyticsErrorReporter(reporter);
    const error = new Error('boom');
    mockCapture.mockImplementation(() => {
      throw error;
    });

    expect(() => analytics.page('home', {})).not.toThrow();
    expect(reporter).toHaveBeenCalledWith(error, { method: 'page' });
  });

  it('reset: does not throw, and reports the failure', () => {
    const reporter = vi.fn();
    setAnalyticsErrorReporter(reporter);
    const error = new Error('boom');
    mockReset.mockImplementation(() => {
      throw error;
    });

    expect(() => analytics.reset()).not.toThrow();
    expect(reporter).toHaveBeenCalledWith(error, { method: 'reset' });
  });
});

// ── FIX ROUND 1 F4 (security S1) — the posthog.init options themselves ──────────────────────
describe('initAnalytics — BAL-529 fix-round-1 F4 SDK-level masking', () => {
  const PREV_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;

  afterEach(() => {
    if (PREV_KEY === undefined) {
      delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    } else {
      process.env.NEXT_PUBLIC_POSTHOG_KEY = PREV_KEY;
    }
    vi.unstubAllGlobals();
  });

  it('wires before_send and the mask_personal_data_properties allowlist into posthog.init', () => {
    // `packages/analytics`'s vitest project runs in the `node` environment (it also ships a
    // server package), so `globalThis.window` is undefined by default — `initAnalytics()`'s
    // browser guard would otherwise skip `posthog.init` entirely and this test would prove
    // nothing. Stubbed rather than switching the whole project to jsdom for one test.
    vi.stubGlobal('window', {});
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test_key';

    initAnalytics();

    expect(mockInit).toHaveBeenCalledTimes(1);
    const [, options] = mockInit.mock.calls[0] as [string, Record<string, unknown>];
    expect(options.before_send).toBe(sanitizeAnalyticsEvent);
    expect(options.mask_personal_data_properties).toBe(true);
    expect(options.custom_personal_data_properties).toEqual([
      'setup_intent',
      'setup_intent_client_secret',
      'redirect_status',
      'payment_intent',
      'payment_intent_client_secret',
    ]);
  });
});

// ── FIX ROUND 3 R1 — posthog.init is the one unguarded analytics call, now guarded ───────────
describe('initAnalytics — BAL-529 fix-round-3 R1 (posthog.init failure is guarded and reported)', () => {
  const PREV_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;

  afterEach(() => {
    if (PREV_KEY === undefined) {
      delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    } else {
      process.env.NEXT_PUBLIC_POSTHOG_KEY = PREV_KEY;
    }
    vi.unstubAllGlobals();
  });

  it('does not throw when posthog.init throws, and reports it with method "init"', async () => {
    // A FRESH module pair, via `vi.resetModules()` + a dynamic re-import (mirrors
    // `track-server.test.ts`'s per-test reset pattern) — `initAnalytics()`'s `initialized` flag
    // and `error-reporter.ts`'s installed `reporter` are both module-level singletons already
    // touched by the F4 test above (and by every `describe` before it in this file), so a fresh
    // pair is the only way to observe THIS call's outcome in isolation. `mockInit` itself is
    // untouched by the reset — it is captured by the `vi.mock('posthog-js', …)` factory's
    // closure over a `const` declared at the top of this file, outside any module boundary.
    vi.resetModules();
    vi.stubGlobal('window', {});
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test_key';

    const { initAnalytics: freshInitAnalytics } = await import('./client');
    const { setAnalyticsErrorReporter: freshSetReporter } = await import('./error-reporter');

    const reporter = vi.fn();
    freshSetReporter(reporter);
    const error = new Error('posthog.init boom');
    mockInit.mockImplementationOnce(() => {
      throw error;
    });

    expect(() => freshInitAnalytics()).not.toThrow();
    expect(reporter).toHaveBeenCalledWith(error, { method: 'init' });
  });
});

// ── FIX ROUND 3 R2 — Session Replay folded into the per-landing refusal, symmetric with Sentry
// Replay's FIX ROUND 1 F12 (`apps/web/instrumentation-client.ts` /
// `sentry-scrub.test.ts`'s "isSensitiveUrl — BAL-529 fix-round-1 F12" suite, mirrored here) ────
describe('initAnalytics — BAL-529 fix-round-3 R2 (disable_session_recording on a sensitive landing)', () => {
  const PREV_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;

  afterEach(() => {
    if (PREV_KEY === undefined) {
      delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    } else {
      process.env.NEXT_PUBLIC_POSTHOG_KEY = PREV_KEY;
    }
    vi.unstubAllGlobals();
  });

  const STRIPE_RETURN_URLS = [
    {
      label: '/settings/billing — setup_intent return',
      href: 'https://balo.expert/settings/billing?setup_intent=seti_abc&setup_intent_client_secret=seti_abc_secret',
    },
    {
      label: '/redeem — setup_intent return',
      href: 'https://balo.expert/redeem?setup_intent=seti_def&redirect_status=succeeded',
    },
  ] as const;

  for (const { label, href } of STRIPE_RETURN_URLS) {
    it(`disables session recording on a Stripe-return landing (${label})`, async () => {
      vi.resetModules();
      mockInit.mockClear();
      vi.stubGlobal('window', {});
      vi.stubGlobal('location', { href });
      process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test_key';

      const { initAnalytics: freshInitAnalytics } = await import('./client');
      freshInitAnalytics();

      const [, options] = mockInit.mock.calls[0] as [string, Record<string, unknown>];
      expect(options.disable_session_recording).toBe(true);
    });
  }

  it('leaves session recording enabled on a normal landing', async () => {
    vi.resetModules();
    mockInit.mockClear();
    vi.stubGlobal('window', {});
    vi.stubGlobal('location', { href: 'https://balo.expert/experts/dana' });
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test_key';

    const { initAnalytics: freshInitAnalytics } = await import('./client');
    freshInitAnalytics();

    const [, options] = mockInit.mock.calls[0] as [string, Record<string, unknown>];
    expect(options.disable_session_recording).toBe(false);
  });
});

describe('BAL-556 replay follows navigation', () => {
  const PREV_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;

  afterEach(() => {
    if (PREV_KEY === undefined) {
      delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    } else {
      process.env.NEXT_PUBLIC_POSTHOG_KEY = PREV_KEY;
    }
    vi.unstubAllGlobals();
  });

  async function boot(
    href: string,
    { withKey = true }: { withKey?: boolean } = {}
  ): Promise<typeof import('./client')> {
    vi.resetModules();
    mockInit.mockClear();
    mockStopSessionRecording.mockReset();
    mockStartSessionRecording.mockReset();
    vi.stubGlobal('window', {});
    vi.stubGlobal('location', { href });
    if (withKey) {
      process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test_key';
    } else {
      delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    }
    const mod = await import('./client');
    mod.initAnalytics();
    return mod;
  }

  function initOptions(): Record<string, unknown> {
    const [, options] = mockInit.mock.calls[0] as [string, Record<string, unknown>];
    return options;
  }

  it('stops on entering a staff surface and resumes with no override on leaving', async () => {
    const { syncSessionReplayToRoute } = await boot('https://balo.expert/dashboard');

    syncSessionReplayToRoute('/admin/lookup');
    expect(mockStopSessionRecording).toHaveBeenCalledTimes(1);

    syncSessionReplayToRoute('/experts/dana');
    expect(mockStartSessionRecording).toHaveBeenCalledTimes(1);
    expect(mockStartSessionRecording).toHaveBeenCalledWith();
  });

  it('is idempotent in both directions', async () => {
    const { syncSessionReplayToRoute } = await boot('https://balo.expert/dashboard');

    syncSessionReplayToRoute('/admin');
    syncSessionReplayToRoute('/admin');
    expect(mockStopSessionRecording).toHaveBeenCalledTimes(1);

    syncSessionReplayToRoute('/');
    syncSessionReplayToRoute('/');
    expect(mockStartSessionRecording).toHaveBeenCalledTimes(1);
  });

  for (const path of [
    '/admin',
    '/admin/',
    '/admin/catalogue',
    '/%61dmin/lookup',
    '/promo-codes',
    '/promo-codes/x',
    '/engagements',
    '/engagements/',
  ]) {
    it(`stops on staff path ${path}`, async () => {
      const { syncSessionReplayToRoute } = await boot('https://balo.expert/dashboard');
      syncSessionReplayToRoute(path);
      expect(mockStopSessionRecording).toHaveBeenCalledTimes(1);
    });
  }

  for (const path of [
    '/administrator',
    '/promo-codesx',
    '/engagements/abc',
    '/engagementsx',
    '/',
  ]) {
    it(`does not stop on non-staff path ${path}`, async () => {
      const { syncSessionReplayToRoute } = await boot('https://balo.expert/dashboard');
      syncSessionReplayToRoute(path);
      expect(mockStopSessionRecording).not.toHaveBeenCalled();
    });
  }

  it('never resumes after a redaction-sensitive landing', async () => {
    const { syncSessionReplayToRoute } = await boot(
      'https://balo.expert/settings/billing?setup_intent=seti_abc&setup_intent_client_secret=seti_abc_secret'
    );

    syncSessionReplayToRoute('/admin');
    syncSessionReplayToRoute('/dashboard');
    expect(mockStopSessionRecording).not.toHaveBeenCalled();
    expect(mockStartSessionRecording).not.toHaveBeenCalled();
  });

  it('disables replay on a staff landing and resumes on leaving it', async () => {
    const { syncSessionReplayToRoute } = await boot('https://balo.expert/admin/catalogue?x=1');
    expect(initOptions().disable_session_recording).toBe(true);

    syncSessionReplayToRoute('/dashboard');
    expect(mockStartSessionRecording).toHaveBeenCalledTimes(1);
  });

  it('treats an admin lookup landing carrying q as redaction-sensitive and never resumes', async () => {
    const { syncSessionReplayToRoute } = await boot('https://balo.expert/admin/lookup?q=x');
    expect(initOptions().disable_session_recording).toBe(true);

    syncSessionReplayToRoute('/dashboard');
    expect(mockStartSessionRecording).not.toHaveBeenCalled();
  });

  it('applies the staff registry to the landing', async () => {
    await boot('https://balo.expert/promo-codes');
    expect(initOptions().disable_session_recording).toBe(true);

    await boot('https://balo.expert/engagements/abc');
    expect(initOptions().disable_session_recording).toBe(false);
  });

  it('stops on client-side navigation into a token path', async () => {
    const { syncSessionReplayToRoute } = await boot('https://balo.expert/dashboard');
    syncSessionReplayToRoute('/shared/proposals/tok');
    expect(mockStopSessionRecording).toHaveBeenCalledTimes(1);
  });

  it('does nothing without a PostHog key', async () => {
    const { syncSessionReplayToRoute } = await boot('https://balo.expert/dashboard', {
      withKey: false,
    });
    syncSessionReplayToRoute('/admin');
    expect(mockStopSessionRecording).not.toHaveBeenCalled();
    expect(mockStartSessionRecording).not.toHaveBeenCalled();
  });

  it('reports an SDK failure with method replay and does not throw', async () => {
    const { syncSessionReplayToRoute } = await boot('https://balo.expert/dashboard');
    const { setAnalyticsErrorReporter: setReporter } = await import('./error-reporter');
    const reporter = vi.fn();
    setReporter(reporter);
    const error = new Error('stop failed');
    mockStopSessionRecording.mockImplementationOnce(() => {
      throw error;
    });

    expect(() => syncSessionReplayToRoute('/admin')).not.toThrow();
    expect(reporter).toHaveBeenCalledWith(error, { method: 'replay' });
    setReporter(null);
  });

  describe('$snapshot drop while suppressed', () => {
    const snapshot = (): CaptureResult => ({
      uuid: 's',
      event: '$snapshot',
      properties: {} as CaptureResult['properties'],
    });
    const pageview = (): CaptureResult => ({
      uuid: 'p',
      event: '$pageview',
      properties: {} as CaptureResult['properties'],
    });

    it('drops $snapshot after entering a staff surface and passes it after leaving', async () => {
      const mod = await boot('https://balo.expert/dashboard');
      expect(mod.sanitizeAnalyticsEvent(snapshot())).not.toBeNull();
      mod.syncSessionReplayToRoute('/admin');
      expect(mod.sanitizeAnalyticsEvent(snapshot())).toBeNull();
      mod.syncSessionReplayToRoute('/dashboard');
      expect(mod.sanitizeAnalyticsEvent(snapshot())).not.toBeNull();
    });

    it('drops $snapshot on a Stripe-return landing', async () => {
      const mod = await boot(
        'https://balo.expert/redeem?setup_intent=seti_def&redirect_status=succeeded'
      );
      expect(mod.sanitizeAnalyticsEvent(snapshot())).toBeNull();
    });

    it('drops the buffer stop() flushes on entering a staff surface', async () => {
      const mod = await boot('https://balo.expert/dashboard');
      const flushed: Array<CaptureResult | null> = [];
      mockStopSessionRecording.mockImplementation(() => {
        flushed.push(mod.sanitizeAnalyticsEvent(snapshot()));
      });
      mod.syncSessionReplayToRoute('/admin/lookup');
      expect(flushed).toEqual([null]);
    });

    it('stops and drops a late-started recorder before resuming on leaving', async () => {
      const mod = await boot('https://balo.expert/dashboard');
      mod.syncSessionReplayToRoute('/admin/lookup');
      const flushed: Array<CaptureResult | null> = [];
      mockStopSessionRecording.mockImplementation(() => {
        flushed.push(mod.sanitizeAnalyticsEvent(snapshot()));
      });
      mod.syncSessionReplayToRoute('/dashboard');
      expect(flushed).toEqual([null]);
      const stops = mockStopSessionRecording.mock.invocationCallOrder;
      const [start] = mockStartSessionRecording.mock.invocationCallOrder;
      expect(stops).toHaveLength(2);
      expect(stops.at(-1) ?? Infinity).toBeLessThan(start ?? -Infinity);
    });

    it('leaves other events untouched while suppressed', async () => {
      const mod = await boot('https://balo.expert/dashboard');
      mod.syncSessionReplayToRoute('/admin');
      expect(mod.sanitizeAnalyticsEvent(pageview())).not.toBeNull();
    });
  });
});
