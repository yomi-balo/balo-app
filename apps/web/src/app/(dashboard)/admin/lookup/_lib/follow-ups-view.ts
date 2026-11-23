import {
  REMINDER_DAILY_LIMIT,
  type ReminderSequenceId,
  type ReminderSkipReason,
} from '@balo/shared/notifications';

/**
 * BAL-666 — the Lookup Follow-ups tab's wire shapes and staff-facing wording. Client-safe: no
 * `server-only`, no `@balo/db` import, so the section component, the Server Action and the pure
 * builder all share one definition.
 *
 * The view carries sentences and labels, never raw rows: no payload, no user id (a wait's id is
 * its newest row's id), no money key. Everything a person reads is decided in `build-lookup-follow-ups.ts`.
 */

/** The Lookup entity types that carry a Follow-ups tab. */
export const LOOKUP_FOLLOW_UP_TYPES = ['user', 'expert', 'project_request', 'engagement'] as const;
export type LookupFollowUpType = (typeof LOOKUP_FOLLOW_UP_TYPES)[number];

/** True when `type` is one of the four Lookup types that has a Follow-ups tab. */
export function hasFollowUpsTab(type: string): type is LookupFollowUpType {
  return (LOOKUP_FOLLOW_UP_TYPES as readonly string[]).includes(type);
}

export type FollowUpStepState = 'sent' | 'due' | 'not_sent' | 'failed';
export type FollowUpWaitState = 'waiting' | 'finished' | 'stopped';

/** A person lens lists what waits on them; an entity lens lists who a thing waits on. */
export type FollowUpLens = 'person' | 'entity';

export interface FollowUpStepView {
  readonly key: string;
  readonly ordinal: string;
  readonly offsetLabel: string;
  readonly state: FollowUpStepState;
  readonly channel: string | null;
  /** The reason as a sentence; `null` for a plain Sent or Due step. */
  readonly sentence: string | null;
  /** The stored code, shown as small print beside the sentence. */
  readonly code: string | null;
  readonly detail: string | null;
  readonly held: string | null;
  readonly whenLabel: string;
}

export interface FollowUpWaitView {
  readonly id: string;
  readonly title: string;
  readonly headline: string;
  readonly context: readonly string[];
  readonly state: FollowUpWaitState;
  readonly summary: string;
  readonly hasFailed: boolean;
  readonly steps: readonly FollowUpStepView[];
}

export interface FollowUpLimitView {
  readonly used: number;
  readonly of: number;
  readonly full: boolean;
}

export interface LookupFollowUpsView {
  readonly lens: FollowUpLens;
  /** The person's first name on a person lens; `null` on an entity lens or when unknown. */
  readonly subjectFirstName: string | null;
  /** Set only for an engagement: the request whose waits are shown. */
  readonly origin: { readonly requestTitle: string } | null;
  /** True for an engagement that did not come from a project request. */
  readonly engagementWithoutRequest: boolean;
  readonly limit: FollowUpLimitView | null;
  readonly now: readonly FollowUpWaitView[];
  readonly earlier: readonly FollowUpWaitView[];
}

export type LookupFollowUpsResult =
  | { readonly ok: true; readonly view: LookupFollowUpsView }
  | { readonly ok: false; readonly reason: 'forbidden' | 'not_found' | 'unavailable' };

export const STEP_LABEL: Readonly<Record<FollowUpStepState, string>> = {
  sent: 'Sent',
  due: 'Due',
  not_sent: 'Not sent',
  failed: 'Failed',
};

export const WAIT_LABEL: Readonly<Record<FollowUpWaitState, string>> = {
  waiting: 'Waiting',
  finished: 'Still waiting · follow-ups finished',
  stopped: 'No longer waiting',
};

export const SEQUENCE_META: Readonly<
  Record<
    ReminderSequenceId,
    { readonly title: string; readonly aboutType: string; readonly channel: string }
  >
> = {
  proposal_review: {
    title: 'Proposals to review',
    aboutType: 'Project request',
    channel: 'Email',
  },
};

const LIMIT_WORDS: readonly string[] = ['no', 'one', 'two', 'three', 'four', 'five'];

/** The daily limit as it reads in a sentence: a word for small values, else the numeral. */
function dailyLimitPhrase(): string {
  const limit: number = REMINDER_DAILY_LIMIT;
  const count = LIMIT_WORDS[limit] ?? String(limit);
  return `${count} follow-up ${limit === 1 ? 'email' : 'emails'}`;
}

/** Skip reasons that read as a sentence. `already_decided` never reaches the tab. */
export type FollowUpReasonKey =
  | Exclude<ReminderSkipReason, 'already_decided'>
  | 'send_failed'
  | 'missed';

export const REASON_SENTENCE: Readonly<
  Record<FollowUpReasonKey, (first: string, attempts: number) => string>
> = {
  no_longer_waiting: () => 'It was no longer waiting by then.',
  over_daily_limit: (first) => `${first} had already had ${dailyLimitPhrase()} today.`,
  recipient_gone: (first) => `${first} was no longer the person this was waiting on.`,
  anchor_moved: () => 'The wait started again, so a new series began.',
  malformed_payload: () => 'Its stored details could not be read, so it was not sent.',
  send_failed: (_first, attempts) =>
    `It could not be sent after ${attempts} ${attempts === 1 ? 'attempt' : 'attempts'}.`,
  missed: () => 'Its send window passed before it could go out.',
};

/** The small-print code for a reason. `send_failed` is a row status, not a skip reason. */
export const REASON_CODE: Readonly<Record<FollowUpReasonKey, string | null>> = {
  no_longer_waiting: 'no_longer_waiting',
  over_daily_limit: 'over_daily_limit',
  recipient_gone: 'recipient_gone',
  anchor_moved: 'anchor_moved',
  malformed_payload: 'malformed_payload',
  send_failed: 'status = failed',
  missed: null,
};

export function isFollowUpReasonKey(value: string): value is FollowUpReasonKey {
  return Object.hasOwn(REASON_SENTENCE, value);
}

/** The hand-off note under a wait whose follow-ups have all gone. */
export const FINISHED_NOTE =
  'Nothing more will be sent. If this still matters, a person needs to step in.';

export const FOOTNOTE =
  'A Due follow-up is sent only if it is still waiting at that time. Times are in the recipient’s own time zone, or Melbourne time when they haven’t set one. From scheduled_notifications; opening this tab writes nothing.';
