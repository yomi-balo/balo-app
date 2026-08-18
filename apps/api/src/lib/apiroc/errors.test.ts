import { describe, expect, it } from 'vitest';
import {
  APIRequestError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  RateLimitError,
  UnifiedCalendarApiError,
} from '@apiroc/unified-calendar-api-node-sdk';
import { captureApirocFailure } from './interceptor.js';
import { ApirocError, normalizeApirocError } from './errors.js';

describe('normalizeApirocError', () => {
  describe('SDK error class → kind table', () => {
    const cases: ReadonlyArray<[string, () => unknown, string, number | undefined]> = [
      ['AuthenticationError → unauthorized', () => new AuthenticationError(), 'unauthorized', 401],
      ['AuthorizationError → forbidden', () => new AuthorizationError(), 'forbidden', 403],
      ['NotFoundError → not_found', () => new NotFoundError(), 'not_found', 404],
      [
        'RateLimitError → rate_limited',
        () => new RateLimitError('Rate limit exceeded', 30),
        'rate_limited',
        429,
      ],
      [
        'APIRequestError 400 → validation',
        () => new APIRequestError('Request failed with status code 400', 400),
        'validation',
        400,
      ],
      [
        'APIRequestError 500 → server_error',
        () => new APIRequestError('Internal error', 500),
        'server_error',
        500,
      ],
      [
        'APIRequestError 409 → unknown (not in the enumerated taxonomy)',
        () => new APIRequestError('Conflict', 409),
        'unknown',
        409,
      ],
      [
        'UnifiedCalendarApiError (no response) → network',
        () => new UnifiedCalendarApiError('Network error'),
        'network',
        undefined,
      ],
    ];

    it.each(cases)('%s', (_label, makeError, expectedKind, expectedStatus) => {
      const result = normalizeApirocError(makeError(), 'test.operation');
      expect(result).toBeInstanceOf(ApirocError);
      expect(result.kind).toBe(expectedKind);
      expect(result.status).toBe(expectedStatus);
      expect(result.operation).toBe('test.operation');
    });
  });

  it('never throws on an unknown-shaped throw (a bare string) and classifies it unknown', () => {
    expect(() => normalizeApirocError('boom', 'test.operation')).not.toThrow();
    const result = normalizeApirocError('boom', 'test.operation');
    expect(result.kind).toBe('unknown');
    expect(result.status).toBeUndefined();
  });

  it('never throws on a bare plain object with no recognizable shape', () => {
    const result = normalizeApirocError({ whatever: true }, 'test.operation');
    expect(result.kind).toBe('unknown');
  });

  describe('ordering — most-specific-first, with teeth', () => {
    it('an AuthenticationError classifies as unauthorized via its OWN branch, not the APIRequestError fallback', () => {
      const err = new AuthenticationError('Authentication failed');
      // AuthenticationError IS an instanceof APIRequestError too (it extends it) — this only
      // proves the correct branch ran if classifyApiRequestErrorStatus(401) would NOT itself
      // produce 'unauthorized'. It doesn't (409/401/403/404/429 → 'unknown' there by design),
      // so this genuinely fails if the chain is ever reordered to check APIRequestError first.
      const result = normalizeApirocError(err, 'endUserAccounts.get');
      expect(result.kind).toBe('unauthorized');
    });

    it('a RateLimitError keeps its retryAfterSeconds — lost if it fell through to the generic APIRequestError branch', () => {
      const err = new RateLimitError('Rate limit exceeded', 42);
      const result = normalizeApirocError(err, 'freeBusy.get');
      expect(result.kind).toBe('rate_limited');
      expect(result.retryAfterSeconds).toBe(42);
    });

    it('a RateLimitError with no Retry-After header has an undefined retryAfterSeconds, never NaN', () => {
      const err = new RateLimitError('Rate limit exceeded', undefined);
      const result = normalizeApirocError(err, 'freeBusy.get');
      expect(result.retryAfterSeconds).toBeUndefined();
      expect(Number.isNaN(result.retryAfterSeconds)).toBe(false);
    });
  });

  describe('wire-evidence capture recovery', () => {
    it('recovers zodIssues (field paths) and requestId from a 400 Envelope B body captured by the interceptor', () => {
      const apiError = new APIRequestError('Request failed with status code 400', 400);
      Object.assign(apiError, {
        config: { method: 'post', url: '/api/v1/events' },
        response: {
          status: 400,
          headers: { 'x-request-id': 'req-abc-123' },
          data: {
            success: false,
            error: {
              name: 'ZodError',
              message: JSON.stringify([
                { path: ['calendarId'], code: 'invalid_type', message: 'Required' },
                { path: ['startDateTime'], code: 'invalid_string', message: 'Invalid datetime' },
              ]),
            },
          },
        },
      });

      captureApirocFailure(apiError);
      const result = normalizeApirocError(apiError, 'events.create');

      expect(result.kind).toBe('validation');
      expect(result.requestId).toBe('req-abc-123');
      expect(result.zodIssues).toEqual([
        { path: 'calendarId', code: 'invalid_type', message: 'Required' },
        { path: 'startDateTime', code: 'invalid_string', message: 'Invalid datetime' },
      ]);
    });

    it('degrades to undefined zodIssues (never throws) when the double-encoded body is malformed JSON', () => {
      const rawLike = {
        message: 'Request failed with status code 400',
        config: { method: 'post', url: '/api/v1/events' },
        response: {
          status: 400,
          headers: {},
          data: { success: false, error: { name: 'ZodError', message: 'not-valid-json{{{' } },
        },
      };

      expect(() => captureApirocFailure(rawLike)).not.toThrow();
      const capture = captureApirocFailure(rawLike);
      expect(capture?.zodIssues).toBeUndefined();

      expect(() => normalizeApirocError(rawLike, 'events.create')).not.toThrow();
    });
  });

  describe('B2 (security review WARNING): wireErrorRaw does not leak through the Pino err serializer', () => {
    it('wireErrorRaw is non-enumerable on the thrown ApirocError', () => {
      const result = normalizeApirocError(
        new APIRequestError('Request failed with status code 400', 400),
        'events.create',
        {
          wireErrorRaw: { error: { message: 'echoes attendee@example.com' } },
        }
      );

      expect(result.wireErrorRaw).toEqual({ error: { message: 'echoes attendee@example.com' } });
      // The load-bearing assertion: an own but NON-enumerable property is invisible to
      // `for…in` (what Pino's default `err` serializer uses to copy "extra" properties)
      // and to `JSON.stringify` / `Object.keys` — while still directly readable above.
      expect(Object.prototype.propertyIsEnumerable.call(result, 'wireErrorRaw')).toBe(false);
      expect(Object.keys(result)).not.toContain('wireErrorRaw');
      expect(Object.getOwnPropertyNames(result)).toContain('wireErrorRaw'); // still an own property
      expect(JSON.stringify(result)).not.toContain('attendee@example.com');
    });
  });

  it('never reads the wire `error` field as a value (only structural extraction, never a literal comparison)', () => {
    // The wire `error` field has been observed as "Error", 404, "InvalidRefreshToken", an
    // object, and more — never an enum. Assert normalizeApirocError still classifies purely
    // from the HTTP status / instanceof, ignoring whatever nonsense is in `error`.
    const apiError = new APIRequestError('Internal error', 500);
    Object.assign(apiError, {
      response: { status: 500, headers: {}, data: { error: 'InternalServerError' } },
    });
    const result = normalizeApirocError(apiError, 'calendars.list');
    expect(result.kind).toBe('server_error');
  });
});
