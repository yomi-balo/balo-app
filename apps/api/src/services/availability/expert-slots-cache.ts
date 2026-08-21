import { createLogger } from '@balo/shared/logging';
import { AVAILABILITY_CACHE_TTL_SECONDS, SLOT_DURATION_LADDER } from '@balo/shared/availability';
import { getRedis } from '../../lib/redis.js';
import { withDeadline } from '../../lib/with-deadline.js';
import { computeExpertSlots, type ExpertSlotsResult } from './expert-slots.js';
import type { BookableSlot } from './slot-grid.js';

const log = createLogger('availability-expert-slots-cache');

/**
 * How long a cache read/write waits for Redis before this layer gives up and falls open to a
 * live compute.
 *
 * ⚠ WITHOUT THIS THE FAIL-OPEN `catch` BELOW IS DEAD CODE, for exactly the reason the rate
 * limiter's was (`lib/with-deadline.ts`): `getRedis()` sets `maxRetriesPerRequest: null`, so a
 * command issued while Redis is unreachable is parked in the offline queue and NEVER SETTLES.
 * The comment saying "falls back to a live compute" would then be a lie and the request would
 * hang instead. Shorter than the limiter's 2s because the fallback here is cheap and local
 * (recompute) rather than a refusal.
 */
export const AVAILABILITY_CACHE_DEADLINE_MS = 1_000;

/**
 * BAL-236 security fix — NEGATIVE-CACHE BREAKER TTL, in seconds.
 *
 * ⚠ THIS IS NOT A CACHED AVAILABILITY ANSWER, AND D13 STILL HOLDS. D13 forbids caching a
 * fail-closed `unavailable` result *as availability* — and `isCacheable` still refuses to write
 * one to the availability key. This is a separate key holding a separate fact: "the last
 * attempt for this expert failed". Without it, `unavailable` is uncached, so EVERY subsequent
 * anonymous request re-runs the full fan-out including a live `freeBusy.get` — and because the
 * vendor port is SHARED with the booking gate (which fails closed on vendor error), sustained
 * anonymous traffic during an Apiroc blip can hold a named expert UNBOOKABLE via `POST
 * /meetings`. Short enough that recovery is near-immediate; long enough that a blip cannot be
 * amplified into a self-sustaining vendor-quota drain.
 */
export const AVAILABILITY_BREAKER_TTL_SECONDS = 15;

/** The subset of `ExpertSlotsResult.status` that is safe to cache AS AVAILABILITY. `unavailable`
 *  (D13) and `expert_not_found` are NEVER written to the availability key — see `isCacheable`.
 *  `unavailable` gets a separate breaker MARKER instead; see `AVAILABILITY_BREAKER_TTL_SECONDS`. */
type CacheableStatus = 'ok' | 'not_configured' | 'no_slots';

/**
 * Compact wire shape for the Redis value — a 14-day grid is ~330 slots, so short keys
 * matter. Version-prefixed key (`v: 1`) so a payload-shape change self-invalidates rather
 * than deserializing into the wrong shape.
 */
interface CachedAvailability {
  v: 1;
  status: CacheableStatus;
  tz: string;
  /** `generatedAt`, ISO. */
  at: string;
  /** `{ s: start ISO, d: maxDuration minutes }`. */
  slots: Array<{ s: string; d: number }>;
}

function cacheKey(expertProfileId: string): string {
  // Version-prefixed, and deliberately WITHOUT `days` — the route always computes and caches
  // the full MAX_AVAILABILITY_WINDOW_DAYS grid and slices on the way out (plan §3.4), so
  // varying `days` cannot multiply vendor reads.
  return `availability:v1:${expertProfileId}`;
}

/** ⚠ A SEPARATE KEY from `cacheKey`, deliberately — see `AVAILABILITY_BREAKER_TTL_SECONDS`. */
function breakerKey(expertProfileId: string): string {
  return `availability:breaker:v1:${expertProfileId}`;
}

interface CachedBreaker {
  v: 1;
  breaker: 'unavailable';
}

function isCacheable(status: ExpertSlotsResult['status']): status is CacheableStatus {
  return status === 'ok' || status === 'not_configured' || status === 'no_slots';
}

function isSlotDurationMinutes(n: number): n is BookableSlot['maxDurationMinutes'] {
  return (SLOT_DURATION_LADDER as readonly number[]).includes(n);
}

function toCached(result: ExpertSlotsResult & { status: CacheableStatus }): CachedAvailability {
  return {
    v: 1,
    status: result.status,
    tz: result.expertTimezone,
    at: result.generatedAt.toISOString(),
    slots: result.slots.map((s) => ({ s: s.startAt.toISOString(), d: s.maxDurationMinutes })),
  };
}

/**
 * Structural guard for a value read back out of Redis. Anything that fails falls through to a
 * live compute rather than being trusted — `tz` in particular ships straight to the browser as
 * `expertTimezone`, so a well-formed-but-wrong payload is worth refusing even though writing
 * one requires Redis access.
 */
function isCachedAvailability(value: unknown): value is CachedAvailability {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<CachedAvailability>;
  if (v.v !== 1) return false;
  if (v.status !== 'ok' && v.status !== 'not_configured' && v.status !== 'no_slots') return false;
  if (typeof v.tz !== 'string' || v.tz === '') return false;
  if (typeof v.at !== 'string' || !Number.isFinite(new Date(v.at).getTime())) return false;
  return Array.isArray(v.slots);
}

function isCachedBreaker(value: unknown): value is CachedBreaker {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<CachedBreaker>;
  return v.v === 1 && v.breaker === 'unavailable';
}

/**
 * Parses a cached payload back into an `ExpertSlotsResult`. Any slot whose duration is not a
 * recognised ladder value, or whose start does not parse, is dropped defensively (a version
 * bump self-invalidates via `v`, so this is a belt-and-braces guard, not the primary defence).
 */
function fromCached(cached: CachedAvailability): ExpertSlotsResult {
  const slots: BookableSlot[] = [];
  for (const s of cached.slots) {
    if (!isSlotDurationMinutes(s.d)) continue;
    const startAt = new Date(s.s);
    if (!Number.isFinite(startAt.getTime())) continue;
    slots.push({ startAt, maxDurationMinutes: s.d });
  }
  return {
    status: cached.status,
    expertTimezone: cached.tz,
    generatedAt: new Date(cached.at),
    slots,
  };
}

/** In-process single-flight, coalescing concurrent computations for the same expert within
 *  one Node process. Cleared in `finally`. With N Railway instances, a cold key can still
 *  produce up to N concurrent vendor reads — a bounded, accepted residual (plan §3.4). */
const inflight = new Map<string, Promise<ExpertSlotsResult>>();

/** One bounded `GET`, JSON-parsed, or `undefined` on ANY failure (miss, outage, malformed). */
async function readKey(expertProfileId: string, key: string): Promise<unknown> {
  try {
    const raw = await withDeadline(() => getRedis().get(key), {
      deadlineMs: AVAILABILITY_CACHE_DEADLINE_MS,
      label: `availability cache get ${key}`,
    });
    if (raw === null) return undefined;
    return JSON.parse(raw) as unknown;
  } catch (error) {
    log.warn(
      { expertProfileId, key, error: error instanceof Error ? error.message : String(error) },
      'Availability cache read failed, computing live'
    );
    return undefined;
  }
}

/** One bounded `SET … EX`. Swallows every failure — the caller already holds the answer. */
async function writeKey(
  expertProfileId: string,
  key: string,
  value: unknown,
  ttlSeconds: number
): Promise<void> {
  try {
    await withDeadline(() => getRedis().set(key, JSON.stringify(value), 'EX', ttlSeconds), {
      deadlineMs: AVAILABILITY_CACHE_DEADLINE_MS,
      label: `availability cache set ${key}`,
    });
  } catch (error) {
    log.warn(
      { expertProfileId, key, error: error instanceof Error ? error.message : String(error) },
      'Availability cache write failed, result already served'
    );
  }
}

async function readThenComputeAndCache(
  expertProfileId: string,
  now: Date
): Promise<ExpertSlotsResult> {
  // FAIL-OPEN on the cache read: any Redis error (unavailable, parse failure, deadline) falls
  // back to a live compute — the opposite fail mode from the rate limiter (§3.6), deliberately.
  const cached = await readKey(expertProfileId, cacheKey(expertProfileId));
  if (isCachedAvailability(cached)) {
    return fromCached(cached);
  }

  // ⚠ THE BREAKER, checked ONLY after a genuine availability miss so a still-valid cached
  // answer always wins. On a hit we answer `unavailable` WITHOUT touching the DB or the vendor
  // — that is the whole point: it caps the RATE of vendor reads on the fail-closed path, which
  // the in-process single-flight (concurrency only) does not.
  const breaker = await readKey(expertProfileId, breakerKey(expertProfileId));
  if (isCachedBreaker(breaker)) {
    log.warn(
      { expertProfileId },
      'Availability breaker open — answering unavailable without a vendor read'
    );
    return { status: 'unavailable', expertTimezone: '', generatedAt: now, slots: [] };
  }

  const result = await computeExpertSlots(expertProfileId, now);

  if (isCacheable(result.status)) {
    await writeKey(
      expertProfileId,
      cacheKey(expertProfileId),
      toCached({ ...result, status: result.status }),
      AVAILABILITY_CACHE_TTL_SECONDS
    );
  } else if (result.status === 'unavailable') {
    // Never the availability key (D13) — only the separate breaker marker.
    await writeKey(
      expertProfileId,
      breakerKey(expertProfileId),
      { v: 1, breaker: 'unavailable' } satisfies CachedBreaker,
      AVAILABILITY_BREAKER_TTL_SECONDS
    );
  }

  return result;
}

/** Redis-cached + in-process single-flight around `computeExpertSlots`. */
export async function getExpertSlots(
  expertProfileId: string,
  now: Date
): Promise<ExpertSlotsResult> {
  const existing = inflight.get(expertProfileId);
  if (existing) return existing;

  const promise = readThenComputeAndCache(expertProfileId, now);
  inflight.set(expertProfileId, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(expertProfileId);
  }
}
