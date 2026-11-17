import { createLogger } from '@balo/shared/logging';
import { NOTIFICATIONS_EVENT_CREATED, notificationsChannelName } from '@balo/shared/realtime';
import { getAblyRest } from '../../lib/ably.js';

const log = createLogger('notification-in-app-push');

/**
 * Publish the content-free `notification.created` ping on the recipient's channel (BAL-620), so
 * their open bell refetches instead of waiting for its next poll.
 *
 * ⚠ IT NEVER REJECTS. The `user_notifications` row is already written when this runs, and the
 * ping is only a latency optimisation — a failed or timed-out publish (the REST client allows
 * one 2 s attempt) must not fail the job, or BullMQ's retry would insert a duplicate row.
 *
 * ⚠ THE WIRE IS A NAME AND NOTHING ELSE: no `data`, no `clientId`, and `extras.ephemeral` so it
 * is exempt from history, rewind and integrations. See `@balo/shared/realtime`.
 */
export async function publishNotificationCreated(recipientId: string): Promise<void> {
  try {
    const client = getAblyRest();
    if (client === null) {
      log.debug(
        { recipientId },
        'Realtime disabled (no ABLY_API_KEY) — skipping notification push'
      );
      return;
    }

    await client.channels.get(notificationsChannelName(recipientId)).publish({
      name: NOTIFICATIONS_EVENT_CREATED,
      extras: { ephemeral: true },
    });
  } catch (error) {
    log.warn(
      {
        recipientId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'Notification push failed'
    );
  }
}
