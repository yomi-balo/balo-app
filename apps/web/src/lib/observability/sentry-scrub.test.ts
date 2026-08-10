import { describe, expect, it } from 'vitest';
import {
  isSensitiveUrl,
  scrubReplayRecordingEvent,
  scrubSentryBreadcrumb,
  scrubSentryEvent,
  sentryScrubbingOptions,
} from './sentry-scrub';

/**
 * ⚠ ALL THREE PREFIXES, NOT JUST BAL-408's. Sentry was unscrubbed for `/review/{token}` and
 * `/shared/proposals/{token}` too — a PRE-EXISTING production leak that this fix closes by
 * construction, because the scrubbers call `redactSensitivePath` and it is driven by
 * `SENSITIVE_PATH_PREFIXES`. Pinning all three is what stops a later "optimisation" that
 * special-cases `/join/` from silently reopening the other two.
 */
const TOKEN = 'gt_5f4dcc3b5aa765d61d8327deb882cf99';

const SENSITIVE_PATHS = [
  { label: 'BAL-408 /join/', path: `/join/${TOKEN}`, redacted: '/join/[redacted]' },
  { label: 'BAL-390 /review/', path: `/review/${TOKEN}`, redacted: '/review/[redacted]' },
  {
    label: 'BAL-386 /shared/proposals/',
    path: `/shared/proposals/${TOKEN}`,
    redacted: '/shared/proposals/[redacted]',
  },
] as const;

const ORIGIN = 'https://balo.expert';

describe('scrubSentryEvent', () => {
  /**
   * ⚠ POSITION 1 — THE ALWAYS-ON SERVER LEAK. `@sentry/nextjs`'s `captureRequestError` does
   * `scope.setContext('nextjs', { request_path: request.path })`, and Next hands
   * `onRequestError` the RESOLVED path, so this is `/join/{raw token}` and never
   * `/join/[token]`. Any server-side throw in the page — a DB blip, a write timeout — fires
   * it, with no attacker involvement at all.
   */
  describe('contexts.nextjs.request_path', () => {
    for (const { label, path, redacted } of SENSITIVE_PATHS) {
      it(`redacts the resolved request path for ${label}`, () => {
        const event = { contexts: { nextjs: { request_path: path, router_kind: 'App' } } };

        const scrubbed = scrubSentryEvent(event);

        expect(scrubbed.contexts.nextjs.request_path).toBe(redacted);
        // Neighbouring diagnostic context must survive — this is a redaction, not a wipe.
        expect(scrubbed.contexts.nextjs.router_kind).toBe('App');
      });
    }

    it('leaves a non-sensitive request path untouched', () => {
      const event = { contexts: { nextjs: { request_path: '/dashboard/projects/123' } } };
      expect(scrubSentryEvent(event).contexts.nextjs.request_path).toBe('/dashboard/projects/123');
    });
  });

  /** ⚠ POSITION 2 — the browser SDK fills `request.url` from `location.href`. */
  describe('request.url', () => {
    for (const { label, path, redacted } of SENSITIVE_PATHS) {
      it(`redacts the full href for ${label}`, () => {
        const event = { request: { url: `${ORIGIN}${path}?utm=email` } };

        expect(scrubSentryEvent(event).request.url).toBe(`${ORIGIN}${redacted}?utm=email`);
      });
    }

    it('redacts a Referer header carrying another page secret', () => {
      const event = {
        request: { url: `${ORIGIN}/onboarding`, headers: { Referer: `${ORIGIN}/join/${TOKEN}` } },
      };

      expect(scrubSentryEvent(event).request.headers.Referer).toBe(`${ORIGIN}/join/[redacted]`);
    });
  });

  /** ⚠ POSITION 3 — `tracesSampleRate` pageload transactions carry the href on span data. */
  describe('span attributes (url.full / http.target)', () => {
    for (const { label, path, redacted } of SENSITIVE_PATHS) {
      it(`redacts url.full and http.target on child spans for ${label}`, () => {
        const event = {
          type: 'transaction',
          spans: [
            {
              op: 'navigation',
              description: `${ORIGIN}${path}`,
              data: { 'url.full': `${ORIGIN}${path}` },
            },
            { op: 'http.client', data: { 'http.target': path, 'http.url': `${ORIGIN}${path}` } },
          ],
        };

        const [navigation, http] = scrubSentryEvent(event).spans;

        expect(navigation?.description).toBe(`${ORIGIN}${redacted}`);
        expect(navigation?.data['url.full']).toBe(`${ORIGIN}${redacted}`);
        expect(http?.data['http.target']).toBe(redacted);
        expect(http?.data['http.url']).toBe(`${ORIGIN}${redacted}`);
      });

      it(`redacts the ROOT span attributes on contexts.trace for ${label}`, () => {
        // The root span is not in `spans` — its attributes live on `contexts.trace.data`,
        // which is where a pageload transaction actually records the URL.
        const event = { contexts: { trace: { data: { 'url.full': `${ORIGIN}${path}` } } } };

        expect(scrubSentryEvent(event).contexts.trace.data['url.full']).toBe(
          `${ORIGIN}${redacted}`
        );
      });
    }

    it('redacts a transaction name that names the raw path', () => {
      const event = { transaction: `/join/${TOKEN}` };
      expect(scrubSentryEvent(event).transaction).toBe('/join/[redacted]');
    });
  });

  /** ⚠ POSITION 4 — Session Replay's `urls`, reachable ONLY via `addEventProcessor`. */
  describe('replay_event.urls', () => {
    it('redacts every sensitive URL the recorded session visited', () => {
      const event = {
        type: 'replay_event',
        urls: [`${ORIGIN}/join/${TOKEN}`, `${ORIGIN}/dashboard`, `${ORIGIN}/review/${TOKEN}?r=5`],
      };

      expect(scrubSentryEvent(event).urls).toEqual([
        `${ORIGIN}/join/[redacted]`,
        `${ORIGIN}/dashboard`,
        `${ORIGIN}/review/[redacted]?r=5`,
      ]);
    });

    it('leaves non-string entries alone rather than throwing', () => {
      const event = { urls: [null, 42, `${ORIGIN}/join/${TOKEN}`] };
      expect(scrubSentryEvent(event).urls).toEqual([null, 42, `${ORIGIN}/join/[redacted]`]);
    });
  });

  describe('attached breadcrumbs', () => {
    it('redacts navigation breadcrumbs carried on the event itself', () => {
      const event = {
        breadcrumbs: [
          { category: 'navigation', data: { from: '/dashboard', to: `/join/${TOKEN}` } },
          { category: 'fetch', data: { url: `${ORIGIN}/review/${TOKEN}` } },
        ],
      };

      const [navigation, fetched] = scrubSentryEvent(event).breadcrumbs;

      expect(navigation?.data.to).toBe('/join/[redacted]');
      expect(navigation?.data.from).toBe('/dashboard');
      expect(fetched?.data.url).toBe(`${ORIGIN}/review/[redacted]`);
    });
  });

  describe('robustness', () => {
    /**
     * A scrubber that throws takes the whole event down with it — Sentry treats a throwing
     * `beforeSend` as a drop. Malformed shapes must be inert, never fatal.
     */
    const MALFORMED = [
      { label: 'null', value: null },
      { label: 'undefined', value: undefined },
      { label: 'a string', value: 'not-an-event' },
      { label: 'an empty object', value: {} },
      { label: 'null contexts', value: { contexts: null } },
      { label: 'a non-array spans', value: { spans: 'nope' } },
      { label: 'a non-string request.url', value: { request: { url: 12345 } } },
      { label: 'holes in breadcrumbs', value: { breadcrumbs: [null, 'x', 7] } },
    ] as const;

    for (const { label, value } of MALFORMED) {
      it(`returns ${label} unchanged instead of throwing`, () => {
        expect(() => scrubSentryEvent(value)).not.toThrow();
        expect(scrubSentryEvent(value)).toBe(value);
      });
    }

    it('returns the SAME object reference, as the SDK requires', () => {
      const event = { request: { url: `${ORIGIN}/join/${TOKEN}` } };
      expect(scrubSentryEvent(event)).toBe(event);
    });

    it('is idempotent — a second pass changes nothing', () => {
      const event = { contexts: { nextjs: { request_path: `/join/${TOKEN}` } } };

      const once = JSON.stringify(scrubSentryEvent(event));
      const twice = JSON.stringify(scrubSentryEvent(event));

      expect(twice).toBe(once);
      expect(twice).toContain('/join/[redacted]');
      expect(twice).not.toContain(TOKEN);
    });
  });
});

describe('scrubSentryBreadcrumb', () => {
  for (const { label, path, redacted } of SENSITIVE_PATHS) {
    it(`redacts data.to and data.from for ${label}`, () => {
      const crumb = { category: 'navigation', data: { from: path, to: path } };

      const scrubbed = scrubSentryBreadcrumb(crumb);

      expect(scrubbed.data.from).toBe(redacted);
      expect(scrubbed.data.to).toBe(redacted);
    });

    it(`redacts data.url for ${label}`, () => {
      const crumb = { category: 'fetch', data: { url: `${ORIGIN}${path}`, status_code: 200 } };

      const scrubbed = scrubSentryBreadcrumb(crumb);

      expect(scrubbed.data.url).toBe(`${ORIGIN}${redacted}`);
      expect(scrubbed.data.status_code).toBe(200);
    });
  }

  it('redacts a message restating the URL', () => {
    const crumb = { message: `Navigated to /join/${TOKEN}` };
    expect(scrubSentryBreadcrumb(crumb).message).toBe('Navigated to /join/[redacted]');
  });

  it('tolerates a breadcrumb with no data bag', () => {
    const crumb = { category: 'ui.click' };
    expect(() => scrubSentryBreadcrumb(crumb)).not.toThrow();
  });
});

describe('scrubReplayRecordingEvent', () => {
  for (const { label, path, redacted } of SENSITIVE_PATHS) {
    it(`redacts a performanceSpan description for ${label}`, () => {
      const frame = {
        type: 5,
        data: {
          tag: 'performanceSpan',
          payload: { op: 'navigation.navigate', description: `${ORIGIN}${path}` },
        },
      };

      expect(scrubReplayRecordingEvent(frame).data.payload.description).toBe(
        `${ORIGIN}${redacted}`
      );
    });

    it(`redacts a breadcrumb frame's navigation data for ${label}`, () => {
      const frame = {
        type: 5,
        data: {
          tag: 'breadcrumb',
          payload: { category: 'navigation', data: { from: '/', to: path } },
        },
      };

      expect(scrubReplayRecordingEvent(frame).data.payload.data.to).toBe(redacted);
    });
  }

  it('returns a non-custom frame untouched rather than throwing', () => {
    // rrweb DOM frames have no `data.payload` at all.
    const frame = { type: 3, data: { source: 2, id: 14 } };
    expect(() => scrubReplayRecordingEvent(frame)).not.toThrow();
    expect(scrubReplayRecordingEvent(frame)).toBe(frame);
  });
});

describe('isSensitiveUrl', () => {
  for (const { label, path } of SENSITIVE_PATHS) {
    it(`is true for ${label}`, () => {
      expect(isSensitiveUrl(path)).toBe(true);
      expect(isSensitiveUrl(`${ORIGIN}${path}`)).toBe(true);
    });
  }

  const NOT_SENSITIVE = ['/', '/dashboard', '/experts/dana', '/join', '/joins/123', '/review'];
  for (const value of NOT_SENSITIVE) {
    it(`is false for ${value}`, () => {
      expect(isSensitiveUrl(value)).toBe(false);
    });
  }

  it('is false for a bare prefix carrying no token', () => {
    // Nothing to withhold, so Replay stays on — the exclusion is targeted, not a blanket
    // "any /join page" rule that would cost coverage for no security gain.
    expect(isSensitiveUrl('/join/')).toBe(false);
  });
});

describe('sentryScrubbingOptions', () => {
  /**
   * The three hooks are what actually wire the scrubbers into `Sentry.init`. Asserting the
   * shape here means a config that spreads this object cannot silently lose one — the
   * failure mode being a channel that goes back to shipping raw tokens with nothing to show
   * for it in a diff.
   */
  it('exposes exactly the three init hooks, each callable', () => {
    expect(Object.keys(sentryScrubbingOptions).sort((a, b) => a.localeCompare(b))).toEqual([
      'beforeBreadcrumb',
      'beforeSend',
      'beforeSendTransaction',
    ]);
  });

  it('scrubs through every hook it exposes', () => {
    const sensitive = `${ORIGIN}/join/${TOKEN}`;
    const expected = `${ORIGIN}/join/[redacted]`;

    expect(sentryScrubbingOptions.beforeSend({ request: { url: sensitive } }).request.url).toBe(
      expected
    );
    expect(
      sentryScrubbingOptions.beforeSendTransaction({ request: { url: sensitive } }).request.url
    ).toBe(expected);
    expect(sentryScrubbingOptions.beforeBreadcrumb({ data: { url: sensitive } }).data.url).toBe(
      expected
    );
  });
});
