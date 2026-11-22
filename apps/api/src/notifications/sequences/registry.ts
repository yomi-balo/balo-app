import {
  REMINDER_SEQUENCE_IDS,
  reminderSequenceKeyPrefix,
  type ReminderSequenceId,
} from '@balo/shared/notifications';
import { proposalReviewSequence } from './proposal-review.js';
import type { ReminderSequence } from './types.js';

export const REMINDER_SEQUENCES: Readonly<Record<ReminderSequenceId, ReminderSequence>> = {
  proposal_review: proposalReviewSequence,
};

/** The sequences, in the order `REMINDER_SEQUENCE_IDS` lists them. */
export function allReminderSequences(): ReminderSequence[] {
  return REMINDER_SEQUENCE_IDS.map((id) => REMINDER_SEQUENCES[id]);
}

/** The dedupe-key prefix of every sequence that counts toward a recipient's daily limit. */
export function limitedSequencePrefixes(): string[] {
  return allReminderSequences()
    .filter((sequence) => !sequence.exemptFromDailyLimit)
    .map((sequence) => reminderSequenceKeyPrefix(sequence.id));
}

/** The sequence a stored id names, or undefined for an id this build does not know. */
export function findReminderSequence(id: unknown): ReminderSequence | undefined {
  const known = REMINDER_SEQUENCE_IDS.find((candidate) => candidate === id);
  return known === undefined ? undefined : REMINDER_SEQUENCES[known];
}
