import { describe, expect, it } from 'vitest';
import { classifyRetry } from './retry.js';
import { ApirocError, type ApirocFailureKind } from './errors.js';

function makeError(kind: ApirocFailureKind, extra: Partial<{ retryAfterSeconds: number }> = {}) {
  return new ApirocError({
    kind,
    operation: 'test.operation',
    status: 0,
    retryAfterSeconds: extra.retryAfterSeconds,
  });
}

describe('classifyRetry', () => {
  const neverRetryKinds: ReadonlyArray<ApirocFailureKind> = [
    'validation',
    'unauthorized',
    'forbidden',
    'not_found',
    'unknown',
  ];

  it.each(neverRetryKinds)('never retries kind=%s', (kind) => {
    const decision = classifyRetry(makeError(kind));
    expect(decision.retry).toBe(false);
    expect(decision.reason.length).toBeGreaterThan(0);
  });

  it('retries server_error', () => {
    const decision = classifyRetry(makeError('server_error'));
    expect(decision.retry).toBe(true);
  });

  it('retries network', () => {
    const decision = classifyRetry(makeError('network'));
    expect(decision.retry).toBe(true);
  });

  describe('rate_limited', () => {
    it('honours retryAfterSeconds, converted to ms', () => {
      const decision = classifyRetry(makeError('rate_limited', { retryAfterSeconds: 30 }));
      expect(decision.retry).toBe(true);
      if (decision.retry) {
        expect(decision.afterMs).toBe(30_000);
      }
    });

    it('falls back to a documented default backoff when retryAfterSeconds is undefined — never NaN', () => {
      const decision = classifyRetry(makeError('rate_limited'));
      expect(decision.retry).toBe(true);
      if (decision.retry) {
        expect(typeof decision.afterMs).toBe('number');
        expect(Number.isNaN(decision.afterMs)).toBe(false);
        expect(decision.afterMs).toBeGreaterThan(0);
      }
    });

    it('handles retryAfterSeconds = 0 without producing 0 as a falsy fallback trigger', () => {
      const decision = classifyRetry(makeError('rate_limited', { retryAfterSeconds: 0 }));
      expect(decision.retry).toBe(true);
      if (decision.retry) {
        expect(decision.afterMs).toBe(0);
      }
    });
  });

  it('fails closed (never retry) for an unclassifiable failure — unbounded amplification guard', () => {
    const decision = classifyRetry(makeError('unknown'));
    expect(decision.retry).toBe(false);
  });
});
