import type { ApirocError } from './errors.js';

export type RetryDecision =
  | { readonly retry: false; readonly reason: string }
  | { readonly retry: true; readonly afterMs?: number; readonly reason: string };

/**
 * Vendor rate-limit magnitude is unmeasured (skill "Rate limits" section — the sandbox probe
 * was never run). Used only when `RateLimitError.retryAfter` is `undefined` (the `Retry-After`
 * header was absent) — never `NaN` in `afterMs` (edge case 6).
 */
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 5000;

/**
 * Pure, no I/O, table-testable — no BullMQ coupling. BAL-396/468 map this onto job options.
 *
 * | Kind            | Decision            | Why                                                    |
 * | --------------- | -------------------- | ------------------------------------------------------ |
 * | validation      | never                | permanent programming error                             |
 * | unauthorized    | never                | credential problem → reconnect (BAL-396 §2)             |
 * | forbidden       | never                | same                                                     |
 * | not_found       | never                |                                                           |
 * | rate_limited    | retry, honour Retry-After (or default backoff) |                                 |
 * | server_error    | retry                |                                                           |
 * | network         | retry                |                                                           |
 * | unknown         | never — fail closed  | unbounded retry amplification against an unmeasured vendor rate limit |
 */
export function classifyRetry(err: ApirocError): RetryDecision {
  switch (err.kind) {
    case 'validation':
      return { retry: false, reason: 'validation errors are permanent programming errors' };
    case 'unauthorized':
      return { retry: false, reason: 'credential problem — requires reconnect, not retry' };
    case 'forbidden':
      return {
        retry: false,
        reason: 'authorization problem — retrying will not change the outcome',
      };
    case 'not_found':
      return { retry: false, reason: 'resource does not exist' };
    case 'rate_limited': {
      const afterMs =
        typeof err.retryAfterSeconds === 'number' && Number.isFinite(err.retryAfterSeconds)
          ? err.retryAfterSeconds * 1000
          : DEFAULT_RATE_LIMIT_BACKOFF_MS;
      return {
        retry: true,
        afterMs,
        reason: 'rate limited — honour Retry-After (or default backoff)',
      };
    }
    case 'server_error':
      return { retry: true, reason: 'server error — likely transient' };
    case 'network':
      return { retry: true, reason: 'network/timeout error — likely transient' };
    case 'unknown':
    default:
      // SonarCloud S1871 — `ApirocFailureKind` is a closed union and every arm above
      // returns, so `default` is unreachable from TypeScript's perspective; it stays only
      // as a runtime safety net for a caller that bypasses the type (e.g. a bad cast), and
      // shares one body with `'unknown'` rather than duplicating it.
      return {
        retry: false,
        reason: 'unclassifiable failure — fail closed to avoid unbounded retry amplification',
      };
  }
}
