import { createLogger } from '@balo/shared/logging';
import {
  NOTIFICATIONS_EVENT_CREATED,
  NOTIFICATIONS_EVENT_READ,
  notificationsChannelName,
} from '@balo/shared/realtime';
import { getAblyRest } from '../../lib/ably.js';

const log = createLogger('notification-in-app-push');

/**
 * Publish one content-free ping on the recipient's channel. ⚠ IT NEVER REJECTS: a failed or
 * timed-out publish (the REST client allows one 2 s attempt) is logged and swallowed.
 *
 * ⚠ THE WIRE IS A NAME AND NOTHING ELSE: no `data`, no `clientId`, and `extras.ephemeral` so it
 * is exempt from history, rewind and integrations. See `@balo/shared/realtime`.
 */
async function publishPing(recipientId: string, name: string): Promise<void> {
  try {
    const client = getAblyRest();
    if (client === null) {
      log.debug(
        { recipientId, name },
        'Realtime disabled (no ABLY_API_KEY) — skipping notification push'
      );
      return;
    }

    await client.channels.get(notificationsChannelName(recipientId)).publish({
      name,
      extras: { ephemeral: true },
    });
  } catch (error) {
    log.warn(
      {
        recipientId,
        name,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'Notification push failed'
    );
  }
}

/**
 * Publish the `notification.created` ping (BAL-620), so the recipient's open bell refetches
 * instead of waiting for its next poll. The `user_notifications` row is already written when this
 * runs and the ping is only a latency optimisation, so a failure must not fail the job (BullMQ's
 * retry would insert a duplicate row).
 */
export function publishNotificationCreated(recipientId: string): Promise<void> {
  return publishPing(recipientId, NOTIFICATIONS_EVENT_CREATED);
}

/**
 * BAL-653 — publish the `notification.read` ping, so every open tab of the recipient refetches
 * and clears a call toast whose rows were marked read server-side.
 */
export function publishNotificationRead(recipientId: string): Promise<void> {
  return publishPing(recipientId, NOTIFICATIONS_EVENT_READ);
}
