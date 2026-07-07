import 'server-only';
import { after } from 'next/server';
import { trackServer, flushServerAnalytics } from '@balo/analytics/server';
import type { ServerEventName, ServerEvents } from '@balo/analytics/server';

export {
  PROJECT_SERVER_EVENTS,
  EXPERT_SERVER_EVENTS,
  BILLING_SERVER_EVENTS,
  PARTY_DOMAIN_SERVER_EVENTS,
  ENGAGEMENT_SERVER_EVENTS,
} from '@balo/analytics/server';
export type { EngagementWorkspaceLens, EngagementWorkspaceEntry } from '@balo/analytics/server';

/**
 * Server-side analytics seam for the web app (RSC / Server Actions). Kept SEPARATE
 * from the client `@/lib/analytics` barrel: `@balo/analytics/server` pulls in
 * `posthog-node`, which must never reach a client bundle — the `server-only` guard
 * turns an accidental client import into a build-time error.
 *
 * Tracks an event AND guarantees delivery on serverless (Vercel). posthog-node
 * batches events in memory; a serverless function can freeze right after the
 * response — including when the render throws `notFound()` / `redirect()` — before
 * the floating POST lands, silently dropping low-frequency events. We enqueue with
 * `trackServer`, then schedule the flush via next/server `after()`: it runs after
 * the response (Vercel keeps the function alive via `waitUntil`) and still runs
 * when the render throws, provided `after()` was registered before the throw.
 * No-op without POSTHOG_API_KEY (the flush is skipped — no instance).
 */
export function trackServerAndFlush<E extends ServerEventName>(
  event: E,
  properties: ServerEvents[E]
): void {
  trackServer(event, properties);
  after(flushServerAnalytics);
}
