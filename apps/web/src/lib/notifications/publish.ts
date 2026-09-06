import 'server-only';
import { loggedFetch } from '@/lib/logging/fetch-wrapper';
import { log } from '@/lib/logging';
import { runAfterResponse } from '@/lib/after-response';
import type { NotificationEvent, EventPayloadMap } from './types';

function getApiUrl(): string {
  const url = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL;
  if (!url) {
    log.warn('API_URL not configured — falling back to localhost:3002');
    return 'http://localhost:3002';
  }
  return url;
}

/**
 * The internal API secret, or `null` after logging the refusal. Shared by BOTH publish forms
 * so neither can drift into publishing unauthenticated: the deferring wrapper checks it up
 * front (so a misconfigured deploy logs on the response path and schedules nothing), and
 * {@link publishNotificationEventNow} checks it again because it is a public entry point in
 * its own right.
 */
function resolveInternalApiSecret(event: NotificationEvent): string | null {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) {
    log.error('INTERNAL_API_SECRET not configured — cannot publish notification event', {
      event,
    });
    return null;
  }
  return secret;
}

/**
 * Publish a notification event to the notification engine RIGHT NOW — the awaitable form,
 * for callers ALREADY inside a deferred context that need the POST to actually settle
 * before they do something else.
 *
 * Use this ONLY from inside a `runAfterResponse` callback (or an equivalent keep-alive
 * scope). On the response path it is a plain blocking fetch, which is exactly what BAL-279
 * moved off that path — plain call sites want {@link publishNotificationEvent}.
 *
 * The motivating caller is the close fan-out
 * (`app/(dashboard)/projects/[requestId]/_actions/_shared/close-request-fanout.ts`): it runs
 * the telling and the cancelled-meeting teardown inside ONE deferred callback and orders the
 * telling first, which is only true if it can await the POST itself. Awaiting the deferring
 * wrapper there bought nothing — that promise resolves as soon as the work is REGISTERED.
 *
 * Never throws, exactly like the wrapper: a missing secret, transport error, or non-2xx
 * response is logged and swallowed (a notification hiccup must never fail the user-facing
 * action). Callers need no `.catch()`.
 */
export async function publishNotificationEventNow<E extends NotificationEvent>(
  event: E,
  payload: EventPayloadMap[E]
): Promise<void> {
  const secret = resolveInternalApiSecret(event);
  if (secret === null) return;

  try {
    const response = await loggedFetch(`${getApiUrl()}/notifications/publish`, {
      service: 'balo-api',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-api-key': secret,
      },
      body: JSON.stringify({ event, payload }),
    });

    if (!response.ok) {
      const body = await response.text();
      log.error('Notification publish failed', {
        event,
        status: response.status,
        body,
      });
    }
  } catch (error) {
    log.error('Notification publish request failed', {
      event,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    // Swallow — notification failure must not break auth/application flows
  }
}

/**
 * Publish a notification event from apps/web to the notification engine via the Fastify
 * internal API — the AUTO-DEFERRING form, and the one plain call sites want.
 *
 * Durability (BAL-279): the cross-service POST is deferred to Next's `after()`
 * (via {@link runAfterResponse}) so it runs AFTER the response flushes but BEFORE
 * Vercel can freeze the function. Previously this was a bare fire-and-forget fetch
 * — on a function freeze right after the Server Action returned, the POST never
 * landed, no BullMQ job was ever enqueued, and there was nothing to retry. Every
 * caller now gets the freeze-safe hop with zero added response latency.
 *
 * Fire-and-forget by contract — never throws to the caller; a missing secret,
 * transport error, or non-2xx response is logged and swallowed (a notification
 * hiccup must never fail the user-facing action). The returned promise resolves
 * eagerly because the work is only REGISTERED here — it exists so existing `.catch()`
 * fire-and-forget call sites keep compiling; do NOT `await` it as delivery
 * confirmation (that durability guarantee is the outbox follow-up, see BAL-279). A
 * caller that genuinely needs to await the POST is already inside a deferred callback
 * and wants {@link publishNotificationEventNow} instead.
 */
export function publishNotificationEvent<E extends NotificationEvent>(
  event: E,
  payload: EventPayloadMap[E]
): Promise<void> {
  if (resolveInternalApiSecret(event) === null) {
    return Promise.resolve();
  }

  runAfterResponse('notification publish', () => publishNotificationEventNow(event, payload));

  return Promise.resolve();
}
