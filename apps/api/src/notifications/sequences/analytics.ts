import type { ScheduledNotification } from '@balo/db';
import { trackServer, REMINDER_SERVER_EVENTS } from '@balo/analytics/server';
import { REMINDER_SEQUENCE_RECHECK } from './recheck.js';
import { findReminderSequence } from './registry.js';

export type ReminderOutcome =
  | { readonly kind: 'published' }
  | { readonly kind: 'skipped'; readonly reason: string };

/** The distinct id for an outcome whose payload names no recipient. */
export const REMINDER_SYSTEM_DISTINCT_ID = 'system:reminder-sequence';

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/**
 * Emits the funnel event for one reminder-sequence row, after the dispatch tick has marked it
 * terminal so each step emits once. A no-op for rows that are not reminder-sequence steps.
 */
export function reportReminderOutcome(row: ScheduledNotification, outcome: ReminderOutcome): void {
  if (row.recheck !== REMINDER_SEQUENCE_RECHECK) {
    return;
  }
  const sequenceId = text(row.payload.sequenceId, 'unknown');
  const step = text(row.payload.step, 'unknown');
  const distinctId = text(row.payload.recipientUserId, REMINDER_SYSTEM_DISTINCT_ID);

  if (outcome.kind === 'skipped') {
    trackServer(REMINDER_SERVER_EVENTS.SKIPPED, {
      sequence: sequenceId,
      step,
      reason: outcome.reason,
      distinct_id: distinctId,
    });
    return;
  }
  const sequence = findReminderSequence(sequenceId);
  if (sequence === undefined) {
    return;
  }
  trackServer(REMINDER_SERVER_EVENTS.SENT, {
    sequence: sequenceId,
    step,
    channel: sequence.channel,
    audience: sequence.audience,
    distinct_id: distinctId,
  });
}
