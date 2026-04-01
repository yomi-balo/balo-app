import 'server-only';
import { loggedFetch } from '@/lib/logging/fetch-wrapper';
import { log } from '@/lib/logging';
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
 * Publish a notification event from apps/web to the notification engine
 * via the Fastify internal API.
 * Fire-and-forget — errors are logged but do not throw
 * (notification failures must not block auth flows).
 */
export async function publishNotificationEvent<E extends NotificationEvent>(
  event: E,
  payload: EventPayloadMap[E]
): Promise<void> {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) {
    log.error('INTERNAL_API_SECRET not configured — cannot publish notification event', {
      event,
    });
    return;
  }

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
