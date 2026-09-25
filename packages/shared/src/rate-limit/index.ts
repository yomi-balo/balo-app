/**
 * BAL-461 — the shared rate-limit contract: the closed BUCKET NAME tuple, the timing
 * constants that keep `apps/web`'s hop inside `apps/api`'s Redis deadline, the wire path, and
 * a pure log-suppression primitive shared by both sides of the hop.
 *
 * PURE and dependency-free (mirrors `@balo/shared/authz`, `@balo/shared/domains`): no I/O, no
 * `@balo/db`, no logging transport. That is what lets `apps/web`'s `checkSharedRateLimit`
 * (a server-only helper) and `apps/api`'s `POST /rate-limit/check` route both import it
 * without pulling either side's runtime into the other's bundle.
 *
 * ⚠ BUCKET **NAMES** LIVE HERE; BUCKET **NUMBERS** DO NOT. The per-bucket `max`/`windowSeconds`
 * config (`Record<RateLimitBucket, RateLimitConfig>`) is `apps/api`-only
 * (`apps/api/src/routes/rate-limit/buckets.ts`) — those are server policy, never sent to or
 * read by the client, and changing a limit must not require a web deploy. Keeping the tuple
 * here instead means `checkSharedRateLimit(bucket, …)` rejects a typo'd bucket name at compile
 * time, and the api route validates the wire value with `z.enum(RATE_LIMIT_BUCKETS)` against
 * the SAME tuple, so the two sides cannot drift into naming a bucket differently.
 */

/**
 * The closed set of shared-counter buckets. Each name is one `POST /rate-limit/check` policy,
 * counted on `apps/api`'s Redis. Adding a bucket is a two-file change (this tuple AND a config
 * entry in `apps/api/src/routes/rate-limit/buckets.ts`, enforced by `buckets.test.ts`'s "the key
 * set equals `RATE_LIMIT_BUCKETS`" case); deploy apps/api before apps/web. An api without the
 * bucket answers 400 (its `z.enum` rejects the unrecognized name), and one without the route at
 * all answers 404 — the web treats both as critical (`checkSharedRateLimit`'s `misconfigured`
 * mapping).
 */
export const RATE_LIMIT_BUCKETS = [
  'meeting-chat-post',
  'meeting-chat-read',
  'meeting-reaction',
  'meeting-realtime-token',
  'typing-signal',
  'proposal-pdf',
] as const;

export type RateLimitBucket = (typeof RATE_LIMIT_BUCKETS)[number];

/** The api route path. Both sides import this instead of a repeated string literal. */
export const RATE_LIMIT_CHECK_PATH = '/rate-limit/check';

/**
 * `apps/web`'s abort budget for the whole `POST /rate-limit/check` round trip.
 *
 * ⚠ MUST STAY STRICTLY GREATER THAN {@link RATE_LIMIT_CHECK_DEADLINE_MS} — pinned by
 * `index.test.ts`. If the web gave up no later than the api's own Redis deadline, a hop that
 * was merely slow in transit (never mind the Redis check itself) would abort before the api
 * could ever answer, turning ordinary network jitter into a guaranteed fail-open.
 */
export const RATE_LIMIT_HOP_TIMEOUT_MS = 150;

/**
 * `apps/api`'s deadline for the `checkRateLimit` Redis MULTI, inside the route's own
 * `withDeadline` wrapper. Deliberately NOT the general-purpose `RATE_LIMIT_DEADLINE_MS`
 * (2 s, `apps/api/src/lib/rate-limiter.ts`) — a healthy MULTI takes single-digit
 * milliseconds, and a longer wait only holds the single Railway replica's connection open for
 * an answer the web has already stopped waiting for.
 */
export const RATE_LIMIT_CHECK_DEADLINE_MS = 100;

/** One admission decision from {@link createLogGate}. */
export interface LogGateVerdict {
  /** `true` on the first call, and on any call at least `intervalMs` after the last admitted one. */
  readonly admitted: boolean;
  /**
   * On an admitted call: how many calls were swallowed since the previously admitted one (`0`
   * for the very first call). On a suppressed call: the running count for the CURRENT window,
   * for callers that want it, though no shipped caller reads it — only the value on an
   * `admitted` verdict is part of the observable contract.
   */
  readonly suppressed: number;
}

/** One log-suppression gate, returned by {@link createLogGate}. */
export interface LogGate {
  /** Offer one event at `nowMs`. Pure — the caller supplies the clock so tests can fake it. */
  admit(nowMs: number): LogGateVerdict;
}

/**
 * A pure "admit at most one event per `intervalMs`" gate. `apps/web`'s fail-open log
 * (`shared-counter.ts`, one gate per serverless instance) and `apps/api`'s Redis-down log
 * (`routes/rate-limit/index.ts`, one gate per process — `railway.toml` runs a single replica)
 * both build one of these, so the suppression logic has exactly one definition instead of two
 * copies that could drift.
 *
 * Never throws, holds no timers, and does nothing at creation time — `admit` is the only
 * effectful call, and it never reads the wall clock itself, so a caller can drive it with a
 * fake `Date.now()` in tests without mocking global time.
 */
export function createLogGate(intervalMs: number): LogGate {
  let lastAdmittedAtMs: number | undefined;
  let suppressedSinceLastAdmit = 0;

  return {
    admit(nowMs: number): LogGateVerdict {
      const dueForAdmission =
        lastAdmittedAtMs === undefined || nowMs - lastAdmittedAtMs >= intervalMs;

      if (dueForAdmission) {
        const suppressed = suppressedSinceLastAdmit;
        lastAdmittedAtMs = nowMs;
        suppressedSinceLastAdmit = 0;
        return { admitted: true, suppressed };
      }

      suppressedSinceLastAdmit += 1;
      return { admitted: false, suppressed: suppressedSinceLastAdmit };
    },
  };
}
