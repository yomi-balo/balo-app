import type { ReminderSequenceId } from '@balo/shared/notifications';
import type { EventPayloadMap } from '../events.js';

/** One waiting entity a sequence reminds about, as of one read of live state. */
export interface SequenceEntity {
  readonly entityId: string;
  /** The instant the step offsets count from. A new anchor starts a fresh sequence. */
  readonly anchor: Date;
  readonly companyId: string;
  /** Users who could receive a step, before `resolveRecipients` checks they still may. */
  readonly candidateUserIds: readonly string[];
  /** Fields the recheck refreshes onto the stored payload at fire time. */
  readonly fresh: Readonly<Record<string, unknown>>;
}

/** How often a sequence's sweep runs. The lead a sweep arms ahead by equals its cadence. */
export type ReminderCadence = 'hourly';

/** The events a reminder sequence publishes. */
export type ReminderEvent = 'project.proposal_review_reminder' | 'project.invitation_reminder';

/**
 * A reminder sequence. The steps are never stored here: they are always read from
 * `REMINDER_SEQUENCE_STEPS[id]` in `@balo/shared/notifications`, so the web app and the sweep
 * cannot disagree about them.
 */
export interface ReminderSequence<E extends ReminderEvent = ReminderEvent> {
  readonly id: ReminderSequenceId;
  readonly event: E;
  /** The payload field that must equal the entity id; the recheck refuses a row where it does not. */
  readonly entityIdField: keyof EventPayloadMap[E] & string;
  readonly channel: 'email';
  readonly audience: 'client' | 'expert';
  readonly cadence: ReminderCadence;
  readonly exemptFromDailyLimit: boolean;
  /** Every entity that waits right now. */
  find(now: Date): Promise<readonly SequenceEntity[]>;
  /** One entity's live state, or null when it no longer waits. */
  evaluate(entityId: string): Promise<SequenceEntity | null>;
  /** The candidates who may still receive a step. */
  resolveRecipients(entity: SequenceEntity): Promise<readonly string[]>;
  buildPayload(
    entity: SequenceEntity,
    stepKey: string,
    recipientUserId: string,
    correlationId: string
  ): EventPayloadMap[E];
}

/** Any one registered sequence, each paired with its own event and payload. */
export type AnyReminderSequence = { [K in ReminderEvent]: ReminderSequence<K> }[ReminderEvent];
