/**
 * BAL-129 — the Daily.co REST seam. Key resolution plus the ONE outbound HTTP helper every
 * Daily call goes through.
 *
 * ⚠ REST, NOT THE SDK, DELIBERATELY. No `@daily-co/*` server package is added to any
 * `package.json`. This ticket makes exactly one vendor call shape (`POST /v1/rooms`, plus a
 * `GET /v1/rooms/{name}` fallback); a dependency for one endpoint is a supply-chain surface
 * and a `tsup` `noExternal`/`external` bookkeeping obligation bought for nothing.
 * `services/airwallex/client.ts` already establishes bare-`fetch`-against-a-vendor-REST-API
 * as house style — this follows it, minus its `!` assertions. The CLIENT-side
 * `@daily-co/daily-js` Call Object SDK is a separate decision owned by BAL-132.
 *
 * ⚠ BARE `fetch`, NOT `loggedFetch`. CLAUDE.md's `loggedFetch` wrapper lives at
 * `apps/web/src/lib/logging/fetch-wrapper` and is a WEB seam; `apps/api` has no equivalent
 * and this ticket does not invent one. The failure is logged at the route boundary with the
 * meeting id attached, which is the actionable context.
 *
 * ⚠ NO RETRY LOOP, AND THAT IS A RULING — see `rooms.ts` for the full argument. In short:
 * room creation is already idempotent at the vendor BY NAME (the name is a pure function of
 * `meetings.id`), so a duplicate request is not a duplicate room; and the caller's failure
 * mode is benign and self-healing. A retry inside a request that has ALREADY COMMITTED a
 * booking just extends the client's wait for no correctness gain.
 */
import { DailyApiError, DailyConfigError } from './errors.js';

/**
 * ⚠ A MODULE CONSTANT, NOT AN ENV VAR (D11). `.env.example` gains `DAILY_API_KEY` and
 * nothing else; a base-URL override would be a second undocumented variable. Tests fake the
 * `fetch` global, not the URL.
 */
export const DAILY_API_BASE = 'https://api.daily.co/v1';

/**
 * ⚠ MANDATORY. Node's `fetch` has NO default timeout. Without this a hung Daily connection
 * holds the booking request open indefinitely — and by the time this call runs the booking
 * has ALREADY COMMITTED, so the client would be left waiting on work that is already
 * durable.
 */
export const DAILY_REQUEST_TIMEOUT_MS = 10_000;

/**
 * The server-side Daily REST key.
 *
 * ⚠ READ LAZILY, INSIDE A FUNCTION — never a module-level `const`. A module-level read
 * would make merely IMPORTING this module fail in every route test and in the shared
 * Fastify app builder whenever the variable is unset. That is exactly why
 * `getStripeClient()` is deferred (`lib/stripe.ts`), and this copies that pattern rather
 * than `services/airwallex/client.ts`'s, which uses `!` on four vars and so turns a
 * misconfiguration into `undefined` flowing into an HTTP header and a cryptic vendor 401.
 *
 * SINGLE ENV VAR, value differs per environment (ADR-1026 topology): no `_PROD` / `_TEST`
 * branching in code.
 */
export function getDailyApiKey(): string {
  const key = process.env.DAILY_API_KEY;
  if (!key) {
    throw new DailyConfigError('DAILY_API_KEY is not set');
  }
  return key;
}

/**
 * One request to the Daily REST API. Throws `DailyConfigError` when the key is missing and
 * `DailyApiError` (carrying the status and the raw body, for the SERVER log) on any non-2xx.
 */
export async function dailyRequest<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown
): Promise<T> {
  const response = await fetch(`${DAILY_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${getDailyApiKey()}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(DAILY_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new DailyApiError(method, path, response.status, await response.text());
  }
  return (await response.json()) as T;
}
