import 'server-only';

import {
  createLogGate,
  RATE_LIMIT_CHECK_PATH,
  RATE_LIMIT_HOP_TIMEOUT_MS,
  type RateLimitBucket,
} from '@balo/shared/rate-limit';
import { log } from '@/lib/logging';
import type { SessionUser } from '@/lib/auth/session';

/**
 * BAL-461 — `apps/web`'s first SHARED rate counter: a thin, secret-gated hop to
 * `POST /rate-limit/check` on `apps/api`, which runs the real Redis `checkRateLimit`. The four
 * in-call chat/reaction/token actions, the three typing actions and the proposal-PDF route call
 * {@link checkSharedRateLimit} after their session read and before their tenancy gate.
 *
 * ⚠ WHY NOT `balo-api-client.ts` (`getApiUrl`/`callBaloApi`)? That client forwards the
 * viewer's WorkOS Bearer token, which does not exist for an impersonated session
 * (`auth/actions/impersonation.ts` — an impersonated session carries no WorkOS token) or a
 * guest. This hop instead uses `requireInternalAuth` on the api side (`x-internal-api-key`,
 * `apps/api/src/lib/internal-auth.ts`): it costs zero DB reads (the Bearer path adds a
 * `users` SELECT per call), and it works identically whether or not the session is
 * impersonated.
 *
 * ⚠ WHY NOT `loggedFetch`? `loggedFetch` writes an info line on every call and an error line
 * on every failure — at up to ~120 calls/min/user (the `typing-signal` bucket's ceiling) that
 * would flood the log volume this module exists to control, and it would defeat the fail-open
 * policy's own observability story, which is exactly ONE gated line per outage window. This
 * module supplies that one line itself, via {@link createLogGate}.
 *
 * ⚠ WHY FAIL OPEN? A limiter outage (Redis down, the secret unset or mismatched, the hop
 * timing out) must never take down chat, typing or the PDF download — those are the actual
 * product, and the limiter is a defence-in-depth control against a script, not a feature. CI
 * E2E also boots no API, so failing closed would break every E2E run through these actions.
 * The exposure is spend only: an outage means no limiting, not a broken surface.
 *
 * ⚠ WHY THE IMPERSONATOR ID? A throttle is per PERSON, not per session. A support session
 * inside a call must neither spend nor be starved by the budget of the user it is
 * impersonating, who may be in the very same call — and the refusal log (on the api) then
 * names the person who actually acted. `actor.impersonatorUserId` is read directly, never a
 * derived `isImpersonating` boolean: `invariants/impersonation-money-guard.test.ts`'s I2 case
 * pins every read of that flag, and this module has no reason to add another one. (Typing
 * never reaches this hop under impersonation at all — `relay-typing-signal.ts` refuses first.)
 *
 * ⚠ `memory-window.ts` (`checkMemoryLimit`) IS NOT A SUBSTITUTE for this module. It is a
 * best-effort, PER-SERVERLESS-INSTANCE fixed window (a module-level `Map`, never shared across
 * Vercel lambdas) used as defence-in-depth on the public token/guest surfaces and the
 * engagement-review submit action. This module is the first counter that is actually SHARED
 * across every instance, because the count lives in `apps/api`'s Redis rather than in
 * web-process memory.
 *
 * ── LATENCY ARITHMETIC, the tightest consumer (typing) ───────────────────────────────────────
 * The typing relay (`typing-relay.ts`) measures a whole call against `TYPING_RELAY_SLOW_MS`
 * (2000 ms) and backs off once a call is that slow, refused or failed. Stacking every ceiling
 * on the path — browser↔Vercel round trip (≤100 ms) + session read (≤20 ms) +
 * {@link RATE_LIMIT_HOP_TIMEOUT_MS} (150 ms, this module's own abort) +
 * the consumer's own tenancy gate (≤150 ms for 6–9 indexed Postgres reads) + the Ably publish
 * (`TYPING_PUBLISH_TIMEOUT_MS`, 1500 ms, `ably-server.ts`) — totals 1920 ms, under the 2000 ms
 * ceiling with 80 ms to spare. `shared-counter.test.ts` pins the piece of that sum that is
 * expressible as named constants (`RATE_LIMIT_HOP_TIMEOUT_MS + TYPING_PUBLISH_TIMEOUT_MS + 270 <
 * TYPING_RELAY_SLOW_MS`, where 270 = 100 + 20 + 150 for the three legs above that have no
 * exported constant of their own). Keeping the api's own Redis deadline
 * (`RATE_LIMIT_CHECK_DEADLINE_MS`, 100 ms) below {@link RATE_LIMIT_HOP_TIMEOUT_MS} means the api
 * never keeps working after the web has already given up and failed open.
 */

/** The subset of the session user this module needs — never the whole `SessionUser`. */
export type SharedRateLimitActor = Pick<SessionUser, 'id' | 'impersonatorUserId'>;

export type SharedRateLimitVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

/** Why a verdict fell back to `{ allowed: true }` instead of a real answer from the api. */
type FailOpenReason =
  | 'missing_secret'
  | 'unauthorized'
  | 'misconfigured'
  | 'unavailable'
  | 'unexpected_status'
  | 'timeout'
  | 'network';

/**
 * The gated fail-open log message, exported so the test pins it verbatim rather than
 * duplicating the literal — the same discipline the api route's refusal log follows for
 * `'Rate limit exceeded'`.
 */
export const SHARED_RATE_LIMIT_UNAVAILABLE_LOG = 'Shared rate limit unavailable — failing open';

/** Reasons that mean the limiter is SILENTLY DISABLED for the whole deploy — logged at `error`. */
const CRITICAL_FAIL_OPEN_REASONS: ReadonlySet<FailOpenReason> = new Set([
  'unauthorized',
  'misconfigured',
]);

const RETRY_AFTER_SECONDS_MIN = 1;
const RETRY_AFTER_SECONDS_MAX = 300;
const DEFAULT_RETRY_AFTER_SECONDS = 60;

const FAIL_OPEN_REASON_BY_STATUS: Readonly<Record<number, FailOpenReason>> = {
  // Adding a bucket is a two-file change (this tuple AND a `buckets.ts` entry); deploy
  // apps/api before apps/web. An api without the bucket answers 400 (its `z.enum` rejects the
  // name) and one without the route at all answers 404 — both mean the wire contract itself is
  // broken, not merely unreachable, so both are critical like a bad secret.
  400: 'misconfigured',
  401: 'unauthorized',
  404: 'misconfigured',
  500: 'misconfigured',
  503: 'unavailable',
};

/**
 * One gate per serverless instance, matching `apps/api`'s own module-level gate for its
 * Redis-down log — see {@link createLogGate}'s docblock for why both sides share the same
 * pure suppression logic instead of each writing their own.
 */
const failOpenLogGate = createLogGate(60_000);

/**
 * A per-instance memo of refusals the shared counter has already issued, keyed
 * `${bucket}:${actorUserId}`. It exists because a hop timeout fails open with no memory of
 * anything: once one refused call is aborted for taking too long, the very next call for the
 * same bucket and person also fails open, even though the shared counter would refuse it again a
 * moment later — and a flood (this person's own traffic, or unrelated api load) can push every
 * later call past the abort. This extends an already-issued refusal across that later timeout;
 * it is NOT a limiter by itself. It never grants: it only narrows a refusal the api already gave
 * into a window where a later call would otherwise fail open.
 *
 * It is not perfectly conservative, though, in two ways: Redis rounds a TTL to the nearest
 * second, so the memo's own window ends {@link REFUSAL_MEMO_SAFETY_MARGIN_MS} before the
 * cooldown the api actually measured, which means it can still over-refuse a caller the api
 * would already admit by under a second at that boundary. And it can hold a refusal stale past
 * the api's own key's real life — after a Redis restart or failover, a manual `DEL`, or a raised
 * limit — until the memo's own expiry, because it has no way to learn the api-side key was
 * cleared.
 *
 * Only set from a `429` whose body actually parsed a `cooldownSeconds` integer — a 429 the hop
 * timeout truncates mid-body-read is otherwise indistinguishable from a genuinely short cooldown,
 * and memoizing the 60 s default in that case would over-refuse for far longer than the api asked
 * for. The CURRENT call still answers with that default; only the memo write is skipped.
 *
 * Capped, and swept on write — reusing the evict-expired-then-oldest approach `memory-window.ts`
 * uses for the same reason: entries expire on their own, but a caller refused once and never
 * seen again must not hold a slot forever.
 */
const REFUSAL_MEMO_MAX_ENTRIES = 10_000;
const REFUSAL_MEMO_SWEEP_BATCH = 64;
/** Redis rounds a TTL to the nearest second; the memo expires this much early to stay conservative. */
const REFUSAL_MEMO_SAFETY_MARGIN_MS = 500;

const refusedUntilByKey = new Map<string, number>();

function refusalMemoKey(bucket: RateLimitBucket, actorUserId: string): string {
  return `${bucket}:${actorUserId}`;
}

/** Drop expired entries first (a bounded scan), then the oldest if the map is still at the cap. */
function evictRefusalMemoOverflow(nowMs: number): void {
  let scanned = 0;
  for (const [key, untilMs] of refusedUntilByKey) {
    if (scanned >= REFUSAL_MEMO_SWEEP_BATCH) break;
    scanned += 1;
    if (nowMs >= untilMs) refusedUntilByKey.delete(key);
  }

  while (refusedUntilByKey.size >= REFUSAL_MEMO_MAX_ENTRIES) {
    const [oldest] = refusedUntilByKey.keys();
    if (oldest === undefined) break;
    refusedUntilByKey.delete(oldest);
  }
}

/** An active memoized refusal for `key`, or `undefined` — clearing it first if it has expired. */
function activeMemoizedRefusal(key: string, nowMs: number): SharedRateLimitVerdict | undefined {
  const untilMs = refusedUntilByKey.get(key);
  if (untilMs === undefined) return undefined;
  if (nowMs >= untilMs) {
    refusedUntilByKey.delete(key);
    return undefined;
  }
  return { allowed: false, retryAfterSeconds: Math.ceil((untilMs - nowMs) / 1000) };
}

/**
 * Remember a 429 the api just issued, so a later timeout for the same key stays refused.
 * `rawCooldownSeconds` is the UNCLAMPED value the api sent, converted to ms and shortened by
 * {@link REFUSAL_MEMO_SAFETY_MARGIN_MS}. Skips the write entirely once that margin would put the
 * memo's own window at or below zero — a cooldown that short is not worth memoizing, and it
 * keeps `evictRefusalMemoOverflow`'s cap from being spent on an entry that is already stale.
 */
function rememberRefusal(key: string, nowMs: number, rawCooldownSeconds: number): void {
  const durationMs = rawCooldownSeconds * 1000 - REFUSAL_MEMO_SAFETY_MARGIN_MS;
  if (durationMs <= 0) return;
  evictRefusalMemoOverflow(nowMs);
  refusedUntilByKey.set(key, nowMs + durationMs);
}

/**
 * ⚠ DELIBERATELY NOT `getApiUrl()` (`lib/api/balo-api-client.ts` and siblings) — that helper
 * writes a `log.warn` on every call when unset, which at this call volume would itself flood
 * the log. Otherwise this mirrors `getApiUrl()`'s exact semantics: an empty `API_URL` falls
 * straight to `localhost:3002`, exactly as `getApiUrl` does; it does not fall through to
 * `NEXT_PUBLIC_API_URL`.
 */
function resolveApiUrl(): string {
  const url = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL;
  return url === undefined || url.length === 0 ? 'http://localhost:3002' : url;
}

function reasonForStatus(status: number): FailOpenReason {
  return FAIL_OPEN_REASON_BY_STATUS[status] ?? 'unexpected_status';
}

/**
 * `TimeoutError` (from `AbortSignal.timeout`) and `AbortError` both mean the hop timed out.
 *
 * ⚠ DUCK-TYPED ON `.name`, NOT `error instanceof Error` — a `DOMException` (what an aborted
 * `fetch` actually rejects with) does not reliably satisfy `instanceof Error` across every
 * realm a test or a runtime may construct it in, and a silent `instanceof` miss here would
 * always fall through to `'network'`, hiding the very timeout rate this reason exists to
 * surface.
 */
function timeoutOrNetworkReason(error: unknown): FailOpenReason {
  const name = hasStringName(error) ? error.name : undefined;
  return name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network';
}

function hasStringName(value: unknown): value is { name: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { name?: unknown }).name === 'string'
  );
}

/** Read the body as text, tolerating any read failure — never throws, never left un-drained. */
async function readBodySafely(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/** Parse a `429` body's `cooldownSeconds`, tolerating a missing or malformed body. */
function readCooldownSeconds(bodyText: string): unknown {
  if (bodyText.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (typeof parsed === 'object' && parsed !== null) {
      return (parsed as Record<string, unknown>)['cooldownSeconds'];
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** The raw `cooldownSeconds` off a `429` body, as a validated integer — or `undefined`. */
function parsedCooldownSeconds(bodyText: string): number | undefined {
  const value = readCooldownSeconds(bodyText);
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

/** Clamp a parsed `cooldownSeconds` to `[1, 300]`; `undefined` falls back to 60. */
function clampRetryAfterSeconds(value: number | undefined): number {
  if (value === undefined) return DEFAULT_RETRY_AFTER_SECONDS;
  return Math.min(Math.max(value, RETRY_AFTER_SECONDS_MIN), RETRY_AFTER_SECONDS_MAX);
}

/**
 * The ONE gated log line this module ever writes. At most once per {@link failOpenLogGate}
 * window (60 s): `error` for a reason that silently disables the limiter for the whole deploy
 * (`unauthorized`, `misconfigured`), `warn` otherwise. Never `info`, and never called at all on
 * a `200` or a `429` — those are real answers, not failures.
 */
function logFailOpen(bucket: RateLimitBucket, reason: FailOpenReason, status?: number): void {
  const { admitted, suppressed } = failOpenLogGate.admit(Date.now());
  if (!admitted) return;

  const data = { bucket, reason, ...(status === undefined ? {} : { status }), suppressed };
  if (CRITICAL_FAIL_OPEN_REASONS.has(reason)) {
    log.error(SHARED_RATE_LIMIT_UNAVAILABLE_LOG, data);
  } else {
    log.warn(SHARED_RATE_LIMIT_UNAVAILABLE_LOG, data);
  }
}

/**
 * Ask `apps/api`'s shared Redis counter whether `actor` may act again on `bucket`. NEVER
 * throws, and NEVER blocks longer than {@link RATE_LIMIT_HOP_TIMEOUT_MS} — every failure mode
 * (missing secret, a non-2xx status, a timeout, a transport error) resolves to
 * `{ allowed: true }` (fail open), logged at most once per minute per {@link logFailOpen}. A
 * refusal the api already issued is remembered for its own cooldown, so a later call that hits a
 * hop timeout for the same bucket and person stays refused instead of failing open — see the
 * refusal-memo comment above.
 *
 * The request is a bare `fetch`, not `loggedFetch` — see the module docblock for why.
 */
export async function checkSharedRateLimit(
  bucket: RateLimitBucket,
  actor: SharedRateLimitActor
): Promise<SharedRateLimitVerdict> {
  const secret = process.env.INTERNAL_API_SECRET;
  if (secret === undefined || secret.length === 0) {
    logFailOpen(bucket, 'missing_secret');
    return { allowed: true };
  }

  // Per-PERSON, not per-session — see the module docblock's "WHY THE IMPERSONATOR ID?" note.
  const actorUserId = actor.impersonatorUserId ?? actor.id;
  const memoKey = refusalMemoKey(bucket, actorUserId);
  const now = Date.now();
  const memoizedRefusal = activeMemoizedRefusal(memoKey, now);
  if (memoizedRefusal !== undefined) {
    return memoizedRefusal;
  }

  let response: Response;
  try {
    response = await fetch(`${resolveApiUrl()}${RATE_LIMIT_CHECK_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-api-key': secret,
      },
      body: JSON.stringify({ bucket, userId: actorUserId }),
      cache: 'no-store',
      signal: AbortSignal.timeout(RATE_LIMIT_HOP_TIMEOUT_MS),
    });
  } catch (error) {
    logFailOpen(bucket, timeoutOrNetworkReason(error));
    return { allowed: true };
  }

  // Every arm below reads (or explicitly drains) the body — undici keeps a keep-alive socket
  // busy until it is read, and a cold socket on the next call would eat into the latency
  // budget this whole module exists to respect.
  const bodyText = await readBodySafely(response);

  if (response.status === 200) {
    return { allowed: true };
  }

  if (response.status === 429) {
    const rawCooldownSeconds = parsedCooldownSeconds(bodyText);
    // Only memoize a cooldown the api actually sent — see the refusal-memo comment above.
    if (rawCooldownSeconds !== undefined) {
      rememberRefusal(memoKey, now, rawCooldownSeconds);
    }
    return { allowed: false, retryAfterSeconds: clampRetryAfterSeconds(rawCooldownSeconds) };
  }

  logFailOpen(bucket, reasonForStatus(response.status), response.status);
  return { allowed: true };
}
