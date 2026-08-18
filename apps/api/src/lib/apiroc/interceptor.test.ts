import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockLog = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => mockLog,
}));

const { UnifiedCalendarApi } = await import('@apiroc/unified-calendar-api-node-sdk');
const { reachAxiosInstance, installInterceptor, captureApirocFailure } =
  await import('./interceptor.js');
const { suppressSdkConsoleLogging } = await import('./logging.js');
const { callApiroc } = await import('./index.js');
const { ApirocError } = await import('./errors.js');

interface StubbableAxiosInstance {
  defaults: { adapter: unknown };
}

/**
 * A synthetic axios rejection shaped exactly like the real thing at the point OUR
 * interceptor sees it: `.config` (so `method`/`url` extract), `.response.headers` (so
 * `x-request-id` extracts), `.response.data` as Envelope B (so the double-encoded Zod
 * issue array extracts). Duck-typed, not a real `AxiosError` instance — `captureApirocFailure`
 * and the SDK's own rejected handler both branch on shape (`error.response`), never
 * `instanceof AxiosError`, so this is faithful to what axios's adapter layer actually
 * hands the interceptor chain on a real HTTP 400.
 */
function envelopeBRejection(config: unknown): unknown {
  return {
    message: 'Request failed with status code 400',
    config,
    response: {
      status: 400,
      headers: { 'x-request-id': 'req-e2e-critical-1' },
      data: {
        success: false,
        error: {
          name: 'ZodError',
          message: JSON.stringify([
            { path: ['calendarId'], code: 'invalid_type', message: 'Required' },
          ]),
        },
      },
    },
  };
}

describe('the installed interceptor, driven end-to-end through a real UnifiedCalendarApi (BAL-467 review C1 — regression gate for CRITICAL #1/#2)', () => {
  beforeEach(() => {
    mockLog.error.mockClear();
    mockLog.warn.mockClear();
  });

  it('install → request fails → our handler runs → SDK mangles the error → callApiroc still surfaces requestId and zodIssues', async () => {
    const api = new UnifiedCalendarApi({ apiKey: 'test-key' });
    const report = installInterceptor(api);
    expect(report.interceptorInstalled).toBe(true);
    expect(report.interceptorPosition).toBe('first');
    suppressSdkConsoleLogging();

    const { axiosInstance } = reachAxiosInstance(api);
    expect(axiosInstance).not.toBeNull();

    // Stub the transport, not the interceptor chain — everything from here down (our
    // handler, the reorder, the SDK's own error-mangling handler) is the REAL registered
    // code, exercised for real for the first time (the WARNING this test closes: "the
    // registered interceptor callbacks are never invoked by any test").
    const stubbable = axiosInstance as unknown as StubbableAxiosInstance;
    stubbable.defaults.adapter = (config: unknown) => Promise.reject(envelopeBRejection(config));

    const rejection = callApiroc('calendars.list', () => api.calendars.list('eua-1'));

    await expect(rejection).rejects.toBeInstanceOf(ApirocError);

    const err: unknown = await rejection.catch((caught: unknown) => caught);
    const apirocError = err as InstanceType<typeof ApirocError>;

    // These are the two option-(b) ACs the review found unmet: the thrown error — not just
    // the log line — carries requestId and the recovered Zod issue array.
    expect(apirocError.kind).toBe('validation');
    expect(apirocError.requestId).toBe('req-e2e-critical-1');
    expect(apirocError.zodIssues).toEqual([
      { path: 'calendarId', code: 'invalid_type', message: 'Required' },
    ]);

    // The capture log line still fires (the pre-existing, order-independent guarantee).
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ status: 400, requestId: 'req-e2e-critical-1' }),
      'apiroc_request_failed'
    );
  });

  it('D2 regression: when the SDK registers no interceptor of its own, position is "first" with no false-alarm warn', () => {
    const fakeHandlers: Array<{ fulfilled?: unknown; rejected?: unknown } | null> = [];
    const fakeAxios = {
      interceptors: {
        response: {
          handlers: fakeHandlers,
          use: (fulfilled?: unknown, rejected?: unknown) => {
            fakeHandlers.push({ fulfilled, rejected });
            return fakeHandlers.length - 1;
          },
        },
      },
    };
    const api = { baseClient: { client: fakeAxios } };

    const report = installInterceptor(api);

    expect(report.interceptorInstalled).toBe(true);
    expect(report.interceptorPosition).toBe('first');
    expect(mockLog.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      'apiroc_interceptor_order_degraded'
    );
  });
});

describe('captureApirocFailure — B1 (security review WARNING): the URL never carries the raw calendar id / email', () => {
  beforeEach(() => {
    mockLog.error.mockClear();
  });

  it('sanitizes a Google-shaped events URL — the calendarId (an email address) never reaches the capture or the log', () => {
    const expertEmail = 'expert.name@gmail.com';
    const error = {
      message: 'Request failed with status code 500',
      config: {
        method: 'get',
        url: `/api/v1/events/eua-abc123/${encodeURIComponent(expertEmail)}`,
      },
      response: { status: 500, headers: {}, data: { message: 'Internal error' } },
    };

    const capture = captureApirocFailure(error);

    expect(capture?.url).not.toContain(expertEmail);
    expect(capture?.url).not.toContain('@');
    expect(capture?.url).toBe('/api/v1/events/[redacted:2]');

    expect(mockLog.error).toHaveBeenCalledTimes(1);
    const [loggedFields] = mockLog.error.mock.calls[0] ?? [];
    expect(JSON.stringify(loggedFields)).not.toContain(expertEmail);
    expect(JSON.stringify(loggedFields)).not.toContain('@');
  });

  it('keeps the resource segments (api/v1/<resource>) — the part that is useful for grep/alerting', () => {
    const capture = captureApirocFailure({
      config: { method: 'get', url: '/api/v1/calendars/eua-1' },
      response: { status: 404, headers: {}, data: {} },
    });
    expect(capture?.url).toBe('/api/v1/calendars/[redacted:1]');
  });

  it('passes a short URL through unchanged when there is nothing to redact', () => {
    const capture = captureApirocFailure({
      config: { method: 'get', url: '/api/v1' },
      response: { status: 500, headers: {}, data: {} },
    });
    expect(capture?.url).toBe('/api/v1');
  });

  it('degrades to undefined, never throws, when url is absent', () => {
    expect(() =>
      captureApirocFailure({
        config: { method: 'get' },
        response: { status: 500, headers: {}, data: {} },
      })
    ).not.toThrow();
    const capture = captureApirocFailure({
      config: { method: 'get' },
      response: { status: 500, headers: {}, data: {} },
    });
    expect(capture?.url).toBeUndefined();
  });

  it('redacts an email-shaped segment even when it falls WITHIN the 3 kept segments (fix brief round 2, item 9 — defence in depth against a future SDK path shape)', () => {
    const expertEmail = 'expert.name@gmail.com';
    const capture = captureApirocFailure({
      config: {
        method: 'get',
        // A hypothetical shorter future SDK path — email lands in segment 3, inside what
        // sanitizeRouteTemplate keeps by position.
        url: `/events/${encodeURIComponent(expertEmail)}`,
      },
      response: { status: 500, headers: {}, data: {} },
    });
    expect(capture?.url).not.toContain(expertEmail);
    expect(capture?.url).not.toContain('@');
    expect(capture?.url).not.toContain('%40');
    expect(capture?.url).toBe('/events/[redacted:email]');
  });

  it('redacts a raw (non-URL-encoded) @ inside a kept segment too', () => {
    const capture = captureApirocFailure({
      config: { method: 'get', url: '/a/b@c' },
      response: { status: 500, headers: {}, data: {} },
    });
    expect(capture?.url).toBe('/a/[redacted:email]');
  });
});
