import { notificationLogRepository } from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import type { NotificationChannel } from '../engine/rules.js';
import type { DeliveryPayload } from './types.js';

const logger = createLogger('notification-log');

/**
 * Which of the two recipient columns this delivery lands in (BAL-341 / ADR-1047 Decision 8).
 *
 * THE RULE IS ONE LINE: **a literal address present ⇒ `recipient_email`, and `recipient_id`
 * is NULL.** `notification_log_recipient_exactly_one` (a CHECK) is the backstop; setting
 * both or neither trips it.
 *
 * | delivery shape                     | `payload.recipientId` today | `recipient_id` | `recipient_email` |
 * |------------------------------------|-----------------------------|----------------|-------------------|
 * | ordinary platform user             | the user uuid               | the uuid       | NULL              |
 * | Balo ops inbox (`admin` + email)   | the ops email STRING        | NULL           | the ops address   |
 * | external invitee (`email_address`) | the invite row's uuid       | NULL           | the invitee       |
 *
 * Both non-user shapes were INVISIBLE before this change, because this function swallows:
 * the ops path pushed a bare email into a `uuid NOT NULL` column (`22P02`) and the external
 * path pushed a valid uuid that is not a `users.id` (`23503`). Dropping the invite uuid from
 * `recipient_id` for the external case loses nothing — `dispatchExternalEmail` already
 * passes that same uuid as the `correlationId`.
 */
function resolveRecipientColumns(payload: DeliveryPayload): {
  recipientId: string | null;
  recipientEmail: string | null;
} {
  const email = payload.recipientEmail;
  if (typeof email === 'string' && email.length > 0) {
    return { recipientId: null, recipientEmail: email };
  }
  return { recipientId: payload.recipientId, recipientEmail: null };
}

/**
 * Best-effort delivery audit, written AFTER the send and never read before one.
 *
 * ⚠ THE SWALLOWING CATCH IS DELIBERATE AND STAYS. A best-effort audit write must never fail
 * a send. The cost, stated plainly (ADR R10): a code path that sets both or neither
 * recipient column trips the CHECK INVISIBLY, as a logged error rather than a broken
 * delivery — so the three shapes above are pinned by `log.test.ts` rather than trusted to
 * review.
 *
 * The CONTRAST with `scheduledNotificationsRepository.claim` is the point: that write is not
 * telemetry, it IS the send-once guarantee, and it has no catch anywhere on its path.
 */
export async function logNotification(
  payload: DeliveryPayload,
  channel: NotificationChannel,
  status: 'sent' | 'failed' | 'skipped',
  error?: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  try {
    const { recipientId, recipientEmail } = resolveRecipientColumns(payload);
    await notificationLogRepository.insert({
      event: payload.event,
      correlationId: payload.payload.correlationId as string,
      recipientId,
      recipientEmail,
      channel,
      template: payload.template,
      status,
      error: error ?? null,
      metadata: metadata ?? null,
    });
  } catch (logError) {
    logger.error(
      {
        event: payload.event,
        template: payload.template,
        error: logError instanceof Error ? logError.message : String(logError),
        stack: logError instanceof Error ? logError.stack : undefined,
      },
      'Failed to write notification log'
    );
  }
}
