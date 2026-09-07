import { createLogger } from '@balo/shared/logging';
import { getServerAnalytics } from './posthog-server';
import type { ServerEvents, ServerEventName } from '../types';

const logger = createLogger('analytics');

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
  try {
    client.capture({
      distinctId: distinct_id,
      event,
      properties: rest,
    });
  } catch (error) {
    // BAL-529 §A — a throw here is inside a Fastify handler or a BullMQ job: it would fail the
    // request, or fail (and retry) the job, for a fire-and-forget side effect. No event
    // PROPERTIES in the log line — the payload can carry PII. Event NAME only.
    logger.error(
      { event, error: error instanceof Error ? error.message : String(error) },
      'PostHog capture failed'
    );
  }
}
