import { getServerAnalytics } from './posthog-server';
import type { ServerEvents, ServerEventName } from '../types';

/**
 * Type-safe server-side event tracking.
 *
 * No-op when POSTHOG_API_KEY is not set.
 * Properties must include `distinct_id` to associate the event with a user.
 */
export function trackServer<E extends ServerEventName>(
  event: E,
  properties: ServerEvents[E]
): void {
  const client = getServerAnalytics();
  if (!client) return;

  const { distinct_id, ...rest } = properties as ServerEvents[E] & { distinct_id: string };
  client.capture({
    distinctId: distinct_id,
    event,
    properties: rest,
  });
}
