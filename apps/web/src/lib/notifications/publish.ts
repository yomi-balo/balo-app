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
 * Publish a notification event from apps/web to the notification engine via the
 * Fastify internal API.
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
 * eagerly because the work is deferred — it exists only so existing `.catch()`
 * fire-and-forget call sites keep compiling; do NOT `await` it as delivery
 * confirmation (that durability guarantee is the outbox follow-up, see BAL-279).
 */
export function publishNotificationEvent<E extends NotificationEvent>(
  event: E,
  payload: EventPayloadMap[E]
): Promise<void> {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) {
    log.error('INTERNAL_API_SECRET not configured — cannot publish notification event', {
      event,
    });
    return Promise.resolve();
  }

  runAfterResponse('notification publish', async () => {
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
  });

  return Promise.resolve();
}
