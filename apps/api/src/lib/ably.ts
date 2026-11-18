import * as Ably from 'ably';

/**
 * Server-side Ably REST seam for `apps/api` (BAL-620). The only publisher today is the in-app
 * notification ping (`notifications/channels/in-app-push.ts`); clients hold subscribe-only
 * tokens minted by `apps/web`, so a tampered client can never spoof a ping. `ABLY_API_KEY` is a
 * dedicated publish-only key (capability `{"notifications:*":["publish"]}`), never the web key.
 *
 * Graceful degradation: `ABLY_API_KEY` unset (dev/CI) → {@link getAblyRest} is `null` and the
 * REST client is never constructed; the bell keeps polling.
 */

/**
 * ⚠ THE PUBLISH BUDGET: one attempt, 2 s. The in-app worker runs 20 jobs concurrently, and
 * Ably's defaults (10 s per request × 3 retries) would let a degraded Ably pin every slot for
 * half a minute. A dropped ping costs nothing: the bell's poll still picks the row up.
 */
export const NOTIFICATION_PUSH_TIMEOUT_MS = 2_000;

let restClient: Ably.Rest | null = null;

/** True when the API holds an Ably API key (realtime transport available). */
export function isAblyConfigured(): boolean {
  const key = process.env.ABLY_API_KEY;
  return typeof key === 'string' && key.length > 0;
}

/** Lazy, bounded REST singleton — `null` when realtime is unconfigured. */
export function getAblyRest(): Ably.Rest | null {
  if (!isAblyConfigured()) return null;
  restClient ??= new Ably.Rest({
    key: process.env.ABLY_API_KEY,
    httpRequestTimeout: NOTIFICATION_PUSH_TIMEOUT_MS,
    httpMaxRetryCount: 0,
  });
  return restClient;
}
