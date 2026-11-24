import { scheduledNotificationsRepository, type ScheduledNotification } from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { formatDateTimeShortUtc, type AdminAlertDetail } from '@balo/shared/admin-alerts';
import { reminderSequenceStepLabel } from '@balo/shared/notifications';
import { raiseAdminAlert } from '../../services/admin-alerts/raise.js';

/**
 * THE ONLY PATH TO A TERMINAL `failed` SCHEDULED NOTIFICATION. It marks the row, writes the
 * structured error line, and raises the admin alert, in that order, so a send that was
 * abandoned is never invisible to the people who run the platform.
 * `invariants/scheduled-notification-fails-through-one-helper.test.ts` pins that
 * `scheduledNotificationsRepository.markFailed(` appears in no other file.
 *
 * ⚠ The Axiom module is the dispatcher's own (`scheduled-notification-dispatch`), so existing
 * log queries keep matching.
 */
const logger = createLogger('scheduled-notification-dispatch');

/** Why a row was abandoned. Each value has exactly one call site in the dispatcher. */
export type ScheduledNotificationFailureCause =
  | 'attempts_exhausted'
  | 'unknown_recheck'
  | 'missing_correlation_id';

const FAILURE_LOG_MESSAGE: Readonly<Record<ScheduledNotificationFailureCause, string>> = {
  attempts_exhausted: 'Scheduled notification abandoned — attempts exhausted',
  unknown_recheck: 'Scheduled notification recheck is not registered — failing closed',
  missing_correlation_id: 'Scheduled notification payload has no correlationId — failing closed',
};

/** The admin alert's content. It carries no money. */
function failureDetail(row: ScheduledNotification, reason: string): AdminAlertDetail {
  const due = formatDateTimeShortUtc(row.scheduledFor);
  const label = reminderSequenceStepLabel(row.dedupeKey) ?? row.event;
  return {
    title: 'A scheduled notification could not be sent',
    entityLabel: label,
    evidence: `It was due ${due} and was abandoned after ${String(row.attempts)} attempt(s).`,
    facts: [
      ['Event', row.event],
      ['Due (UTC)', row.scheduledFor.toISOString()],
      ['Attempts', String(row.attempts)],
      ['Reason', reason],
      ['Key', row.dedupeKey],
    ],
  };
}

/**
 * Terminal-`failed` one claimed row and tell the admin queue.
 *
 * ⚠ ORDER: the mark comes first, so a `markFailed` that throws raises nothing and leaves the row
 * `claimed` for the TTL reconcile. The alert is best-effort: building its detail and raising it
 * sit in one guard, so nothing after the mark can change the returned `'failed'`. It is
 * idempotent on `(kind, entity_id)`, so two replicas abandoning one row still leave
 * a single open alert.
 */
export async function failScheduledNotification(
  row: ScheduledNotification,
  cause: ScheduledNotificationFailureCause,
  reason: string,
  context: Readonly<Record<string, unknown>> = {}
): Promise<'failed'> {
  await scheduledNotificationsRepository.markFailed(row.id, reason);
  logger.error(
    {
      id: row.id,
      key: row.dedupeKey,
      event: row.event,
      attempts: row.attempts,
      ...context,
    },
    FAILURE_LOG_MESSAGE[cause]
  );
  try {
    await raiseAdminAlert({
      kind: 'scheduled_notification.failed',
      entityType: 'scheduled_notification',
      entityId: row.id,
      detail: failureDetail(row, reason),
    });
  } catch (error) {
    logger.error(
      {
        id: row.id,
        key: row.dedupeKey,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'Scheduled notification admin alert could not be raised'
    );
  }
  return 'failed';
}
