import {
  scheduledNotificationsRepository,
  usersRepository,
  type ScheduledNotification,
} from '@balo/db';
import {
  REMINDER_DAILY_LIMIT,
  reminderLocalDayStart,
  reminderRecipientZone,
  REMINDER_SEQUENCE_STEPS,
} from '@balo/shared/notifications';
import { createLogger } from '@balo/shared/logging';
import type { ScheduledRecheck } from '../scheduling/rechecks.js';
import { isScheduledKeyDecided } from '../scheduling/scheduled-key-decided.js';
import { findReminderSequence, limitedSequencePrefixes } from './registry.js';
import type { ReminderSequence } from './types.js';

const log = createLogger('reminder-sequence-recheck');

/** The registry key for the reminder-sequence guard. ⚠ Must match `SCHEDULED_RECHECKS`. */
export const REMINDER_SEQUENCE_RECHECK = 'reminder_sequence';

/** Every skip the guard records. */
export const REMINDER_SKIP_REASONS = [
  'malformed_payload',
  'already_decided',
  'no_longer_waiting',
  'anchor_moved',
  'recipient_gone',
  'over_daily_limit',
] as const;
export type ReminderSkipReason = (typeof REMINDER_SKIP_REASONS)[number];

/**
 * The only skip after which a step may be armed again: the sequence's anchor moved, and a later
 * sweep arms the new anchor under a new key. The rest are final.
 */
export const REARMABLE_REMINDER_SKIP_REASONS: readonly ReminderSkipReason[] = ['anchor_moved'];

interface ParsedPayload {
  readonly sequenceId: string;
  readonly entityId: string;
  readonly anchorIso: string;
  readonly recipientUserId: string;
}

/** Fully anchored, fixed repetition: linear, no S5852 backtracking. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** True when `value` is an instant written exactly as `Date#toISOString` writes it. */
function isRoundTrippedIso(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** The stored payload's identifying fields, or null when any is missing or unusable. */
function parsePayload(row: ScheduledNotification): ParsedPayload | null {
  const { correlationId, sequenceId, step, entityId, anchorIso, recipientUserId } = row.payload;
  if (
    !nonBlank(correlationId) ||
    !nonBlank(sequenceId) ||
    !nonBlank(step) ||
    !isUuid(entityId) ||
    !isUuid(recipientUserId) ||
    !nonBlank(anchorIso) ||
    !isRoundTrippedIso(anchorIso)
  ) {
    return null;
  }
  const sequence = findReminderSequence(sequenceId);
  if (
    sequence?.event !== row.event ||
    !REMINDER_SEQUENCE_STEPS[sequence.id].some((known) => known.key === step) ||
    !sequence.payloadMatchesEntity(row.payload, entityId)
  ) {
    return null;
  }
  return { sequenceId, entityId, anchorIso, recipientUserId };
}

/** The stored fields that say who a step is for and which entity it is about. */
const IDENTITY_FIELDS = [
  'correlationId',
  'sequenceId',
  'step',
  'entityId',
  'anchorIso',
  'recipientUserId',
] as const;

/**
 * True when merging the live `fresh` fields left the stored identity intact: the common step
 * fields are unchanged and the sequence's own entity and recipient fields still agree with them.
 * `fresh` may refresh display fields only, never redirect a step to another recipient or entity.
 */
function identityPreserved(
  stored: Readonly<Record<string, unknown>>,
  merged: Readonly<Record<string, unknown>>,
  sequence: ReminderSequence,
  entityId: string
): boolean {
  return (
    IDENTITY_FIELDS.every((field) => merged[field] === stored[field]) &&
    sequence.payloadMatchesEntity(merged, entityId)
  );
}

function skip(reason: ReminderSkipReason): { publish: false; reason: string } {
  return { publish: false, reason };
}

/**
 * THE REMINDER-SEQUENCE GUARD. At fire time it re-reads the entity and publishes only while the
 * reminder is still owed, to a recipient who may still receive it, within the daily limit (two a day, counted per local day: since midnight in the recipient's zone).
 *
 * ⚠ ORDER MATTERS: the daily-limit check runs last, so a reminder that is no longer needed never
 * counts as over the limit. A repository throw propagates, leaving the row `claimed` for retry.
 */
export const reminderSequenceRecheck: ScheduledRecheck = async (row) => {
  const decision = await decide(row);
  if (decision.publish) {
    log.info({ id: row.id, event: row.event }, 'Reminder sequence step publishing');
  } else {
    log.info(
      { id: row.id, event: row.event, reason: decision.reason },
      'Reminder sequence skipped'
    );
  }
  return decision;
};

async function decide(row: ScheduledNotification): ReturnType<ScheduledRecheck> {
  const parsed = parsePayload(row);
  const sequence = parsed === null ? undefined : findReminderSequence(parsed.sequenceId);
  if (parsed === null || sequence === undefined) {
    return skip('malformed_payload');
  }
  if (await isScheduledKeyDecided(row.dedupeKey, REARMABLE_REMINDER_SKIP_REASONS, row.id)) {
    return skip('already_decided');
  }
  const entity = await sequence.evaluate(parsed.entityId);
  if (entity === null) {
    return skip('no_longer_waiting');
  }
  if (entity.anchor.toISOString() !== parsed.anchorIso) {
    return skip('anchor_moved');
  }
  const recipients = await sequence.resolveRecipients(entity);
  if (!recipients.includes(parsed.recipientUserId)) {
    return skip('recipient_gone');
  }
  if (!sequence.exemptFromDailyLimit) {
    const now = new Date();
    const context = await usersRepository.findTimezoneContext(parsed.recipientUserId, undefined);
    const zone = reminderRecipientZone(context?.savedTimezone);
    const recentSends = await scheduledNotificationsRepository.countRecentSequenceSends({
      recipientUserId: parsed.recipientUserId,
      dedupeKeyPrefixes: limitedSequencePrefixes(),
      since: reminderLocalDayStart(now, zone),
      asking: { id: row.id, scheduledFor: row.scheduledFor },
    });
    if (recentSends >= REMINDER_DAILY_LIMIT) {
      return skip('over_daily_limit');
    }
  }
  const merged = { ...row.payload, ...entity.fresh };
  if (!identityPreserved(row.payload, merged, sequence, parsed.entityId)) {
    return skip('malformed_payload');
  }
  return { publish: true, payload: merged };
}
