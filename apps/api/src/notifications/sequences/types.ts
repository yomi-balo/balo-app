import type { ReminderChannel, ReminderSequenceId } from '@balo/shared/notifications';
import type { EventPayloadMap } from '../events.js';

export type { ReminderChannel };

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

/** The event each sequence publishes. A new sequence adds one line here and one registry entry. */
export interface ReminderSequenceEvents {
  proposal_review: 'project.proposal_review_reminder';
  delivery_review: 'engagement.review_reminder';
  invitation: 'project.invitation_reminder';
}

/** Every event a reminder sequence can publish. */
export type ReminderEvent = ReminderSequenceEvents[ReminderSequenceId];

/**
 * A reminder sequence. The steps are never stored here: they are always read from
 * `REMINDER_SEQUENCE_STEPS[id]` in `@balo/shared/notifications`, so the web app and the sweep
 * cannot disagree about them.
 */
export interface ReminderSequence<E extends ReminderEvent = ReminderEvent> {
  readonly id: ReminderSequenceId;
  readonly event: E;
  /** Every channel the event's rule delivers on; the first is the one `reminder_sent` reports. */
  readonly channels: readonly [ReminderChannel, ...ReminderChannel[]];
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
  /**
   * True when a stored payload names `entityId` the way this sequence's own payload does. The
   * recheck's common guard cannot know the event's entity field, so each sequence checks it.
   */
  payloadMatchesEntity(payload: Readonly<Record<string, unknown>>, entityId: string): boolean;
  /** Extra post-publish tracking for a sequence with its own legacy event. Runs once per publish. */
  trackPublished?(payload: Readonly<Record<string, unknown>>): void;
}
