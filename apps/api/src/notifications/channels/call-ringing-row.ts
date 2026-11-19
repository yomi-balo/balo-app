import { meetingRingsRepository, userNotificationsRepository } from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { publishNotificationRead } from './in-app-push.js';

const log = createLogger('call-ringing-row');

/** Mark the callee's unread ringing rows for one ring read, and ping their tabs when any changed. */
async function retractRows(calleeUserId: string, ringId: string): Promise<void> {
  const ids = await userNotificationsRepository.markCallRingingReadByRingId(calleeUserId, ringId);
  if (ids.length === 0) {
    return;
  }
  log.info({ ringId, count: ids.length }, 'Ringing notification retracted');
  await publishNotificationRead(calleeUserId);
}

function failureFields(error: unknown): { error: string; stack: string | undefined } {
  return {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  };
}

/**
 * BAL-653 — a ring ended (connected, declined, stopped or unanswered): mark the callee's
 * `call.ringing` bell row read so it never lingers as a stale "incoming call" item. The ring
 * services publish the terminal event after the status commits, so by the time this runs the
 * ring is over.
 *
 * ⚠ BEST EFFORT: a payload without both ids is skipped, and a failure is logged and swallowed — a
 * retraction problem must never fail the event it rides.
 */
export async function retractCallRingingRow(payload: Record<string, unknown>): Promise<void> {
  const { ringId, calleeUserId } = payload;
  if (typeof ringId !== 'string' || typeof calleeUserId !== 'string') {
    log.warn({ ringId, calleeUserId }, 'Ringing retraction skipped: payload lacks ring or callee');
    return;
  }
  try {
    await retractRows(calleeUserId, ringId);
  } catch (error) {
    log.warn({ ringId, ...failureFields(error) }, 'Ringing notification retraction failed');
  }
}

/**
 * BAL-653 — runs after a `call.ringing` row is inserted. If the ring already left `ringing`
 * (the terminal event's retraction found no row because this insert had not landed), mark the
 * row read now. Closes the insert-after-retract race: the ring service commits the status before
 * publishing the terminal event, and this reads the status after inserting the row.
 *
 * ⚠ BEST EFFORT: never throws.
 */
export async function reconcileCallRingingRow(input: {
  ringId: unknown;
  recipientId: string;
}): Promise<void> {
  const { ringId, recipientId } = input;
  if (typeof ringId !== 'string') {
    return;
  }
  try {
    const ring = await meetingRingsRepository.findById(ringId);
    if (ring?.status === 'ringing') {
      return;
    }
    await retractRows(recipientId, ringId);
  } catch (error) {
    log.warn({ ringId, ...failureFields(error) }, 'Ringing notification reconcile failed');
  }
}
