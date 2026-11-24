import { canonicalTimezone, zonedWallClockToUtc } from '../timezone';
import { AUTO_ACCEPT_DAYS, REVIEW_REMINDER_LEAD_DAYS } from '../engagements/delivery-review';

export const REMINDER_SEQUENCE_IDS = ['proposal_review', 'delivery_review', 'invitation'] as const;
export type ReminderSequenceId = (typeof REMINDER_SEQUENCE_IDS)[number];

export type ReminderStepTiming = 'exact' | 'weekday_morning';

export interface ReminderStep {
  readonly key: string;
  readonly offsetMinutes: number;
  readonly timing: ReminderStepTiming;
}

export const reminderDays = (days: number): number => days * 1440;

export const REMINDER_SEQUENCE_STEPS: Readonly<
  Record<ReminderSequenceId, readonly ReminderStep[]>
> = {
  proposal_review: [
    { key: 'day_2', offsetMinutes: reminderDays(2), timing: 'weekday_morning' },
    { key: 'day_5', offsetMinutes: reminderDays(5), timing: 'weekday_morning' },
    { key: 'day_9', offsetMinutes: reminderDays(9), timing: 'weekday_morning' },
  ],
  delivery_review: [
    {
      key: 'pre_auto_accept',
      offsetMinutes: reminderDays(AUTO_ACCEPT_DAYS - REVIEW_REMINDER_LEAD_DAYS),
      timing: 'exact',
    },
  ],
  invitation: [
    { key: 'day_1', offsetMinutes: reminderDays(1), timing: 'weekday_morning' },
    { key: 'day_3', offsetMinutes: reminderDays(3), timing: 'weekday_morning' },
  ],
};

/** Names of the shared rules each sequence's finder must call rather than re-implement. */
export const REMINDER_SEQUENCE_SHARED_RULES: Readonly<
  Record<ReminderSequenceId, readonly string[]>
> = {
  proposal_review: ['proposalAwaitsClientReview', 'proposalReviewWait'],
  delivery_review: ['deliveryReviewWait'],
  invitation: ['expertInvitationMove', 'invitationReminderWait'],
};

/**
 * The fields every reminder payload carries, whatever the sequence's event: the sequence/step
 * identity the recheck guard reads back (`sequenceId`, `step`, `entityId`, `anchorIso`,
 * `recipientUserId`) plus the per-promise `correlationId`.
 */
export interface ReminderStepFields {
  correlationId: string;
  sequenceId: ReminderSequenceId;
  step: string;
  entityId: string;
  anchorIso: string;
  recipientUserId: string;
}

/**
 * Whether a sequence's steps skip the per-recipient daily limit. A sequence that is not exempt
 * counts toward `REMINDER_DAILY_LIMIT` and is held back once a recipient has had that many
 * published sends since local midnight.
 */
export const REMINDER_SEQUENCE_EXEMPT_FROM_DAILY_LIMIT: Readonly<
  Record<ReminderSequenceId, boolean>
> = {
  proposal_review: false,
  delivery_review: true,
  invitation: false,
};

/** The delivery channels a reminder promise covers. */
export type ReminderChannel = 'email' | 'in_app';

/**
 * Every channel each sequence's event rule delivers on; the first is the one `reminder_sent`
 * reports. The sweep registry and the Lookup Follow-ups tab both read this record.
 */
export const REMINDER_SEQUENCE_CHANNELS: Readonly<
  Record<ReminderSequenceId, readonly [ReminderChannel, ...ReminderChannel[]]>
> = {
  proposal_review: ['email'],
  delivery_review: ['email', 'in_app'],
  invitation: ['email'],
};

/** Who each sequence reminds: the client side or the expert side of the engagement. */
export const REMINDER_SEQUENCE_AUDIENCE: Readonly<Record<ReminderSequenceId, 'client' | 'expert'>> =
  {
    proposal_review: 'client',
    delivery_review: 'client',
    invitation: 'expert',
  };

/** Every skip the recheck guard records on a scheduled reminder row. */
export const REMINDER_SKIP_REASONS = [
  'malformed_payload',
  'already_decided',
  'no_longer_waiting',
  'anchor_moved',
  'recipient_gone',
  'over_daily_limit',
] as const;
export type ReminderSkipReason = (typeof REMINDER_SKIP_REASONS)[number];

export const MAX_REMINDER_STEPS = 3;
export const REMINDER_DAILY_LIMIT = 2;
export const REMINDER_ARMABLE_AFTER_DUE_MS = 86_400_000;
export const REMINDER_DEFAULT_ZONE = 'Australia/Melbourne';
export const REMINDER_MORNING_HOUR = 9;
export const REMINDER_SEQUENCE_KEY_PREFIX = 'seq:';

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;
/** The weekend hold plus the window in which a missed step may still be armed. */
const SEQUENCE_SPAN_PADDING_DAYS = 4;

const SATURDAY = 6;
const SUNDAY = 0;
const MINUTE_MS = 60_000;

/**
 * The zone a reminder's send window is read in. A saved zone is used as its canonical name;
 * blank, unrecognised and `UTC` (the column default, meaning unset) fall back to Melbourne.
 */
export function reminderRecipientZone(saved: string | null | undefined): string {
  if (!saved) return REMINDER_DEFAULT_ZONE;
  const canonical = canonicalTimezone(saved);
  if (canonical === null || canonical === 'UTC') return REMINDER_DEFAULT_ZONE;
  return canonical;
}

function localParts(instant: Date, zone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(instant);
  const read = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? Number.NaN);
  return { year: read('year'), month: read('month'), day: read('day') };
}

/**
 * When a step is actually sent. `exact` is the due instant. `weekday_morning` is 09:00 local on
 * the due date's local day; if that is already before the due instant it moves to the next day,
 * and it keeps moving while the local weekday is Saturday or Sunday.
 */
export function reminderSendAt(dueAt: Date, timing: ReminderStepTiming, zone: string): Date {
  if (timing === 'exact') return dueAt;
  const { year, month, day } = localParts(dueAt, zone);
  let dayOffset = 0;
  for (let guard = 0; guard < 10; guard += 1) {
    const probe = new Date(Date.UTC(year, month - 1, day + dayOffset));
    const weekday = probe.getUTCDay();
    const candidate = zonedWallClockToUtc(zone, {
      year: probe.getUTCFullYear(),
      month: probe.getUTCMonth() + 1,
      day: probe.getUTCDate(),
      hour: REMINDER_MORNING_HOUR,
      minute: 0,
    });
    const isWeekend = weekday === SATURDAY || weekday === SUNDAY;
    if (!isWeekend && candidate.getTime() >= dueAt.getTime()) return candidate;
    dayOffset += 1;
  }
  return dueAt;
}

export interface ReminderStepSendTime {
  readonly stepKey: string;
  readonly fireAt: Date;
}

/**
 * When every step of a sequence is sent, in step order. Each step is its offset from the anchor
 * with `reminderSendAt` applied. A `weekday_morning` step whose send time would not be strictly
 * after the previous step's moves to the next weekday morning, so two steps never land on the
 * same morning: a Thursday-afternoon `invitation` sends day_1 on Monday and day_3 on Tuesday,
 * and a `proposal_review` anchored on the Wednesday morning before clocks go back sends day_2 on
 * Monday and day_5 on Tuesday. The sweep and anything that shows a schedule both read this, so
 * they agree on the morning.
 */
export function reminderStepSendTimes(input: {
  steps: readonly ReminderStep[];
  anchor: Date;
  zone: string;
}): ReminderStepSendTime[] {
  const out: ReminderStepSendTime[] = [];
  let previous: Date | null = null;
  for (const step of input.steps) {
    const dueAt = new Date(input.anchor.getTime() + step.offsetMinutes * MINUTE_MS);
    let fireAt = reminderSendAt(dueAt, step.timing, input.zone);
    if (
      step.timing === 'weekday_morning' &&
      previous !== null &&
      fireAt.getTime() <= previous.getTime()
    ) {
      fireAt = reminderSendAt(new Date(previous.getTime() + 1), 'weekday_morning', input.zone);
    }
    previous = fireAt;
    out.push({ stepKey: step.key, fireAt });
  }
  return out;
}

/**
 * 00:00 local on `now`'s local date in `zone`: the start of the per-day window the daily limit
 * counts sends from. Taken from the zone's wall clock, so a 23h or 25h DST day still starts at
 * local midnight.
 */
export function reminderLocalDayStart(now: Date, zone: string): Date {
  const { year, month, day } = localParts(now, zone);
  return zonedWallClockToUtc(zone, { year, month, day, hour: 0, minute: 0 });
}

export function reminderSequenceKey(p: {
  sequenceId: ReminderSequenceId;
  entityId: string;
  stepKey: string;
  userId: string;
  anchorIso: string;
}): string {
  return `${reminderSequenceKeyPrefix(p.sequenceId)}${p.entityId}:${p.stepKey}:${p.userId}:${p.anchorIso}`;
}

export function reminderSequenceKeyPrefix(id: ReminderSequenceId): string {
  return `${REMINDER_SEQUENCE_KEY_PREFIX}${id}:`;
}

/**
 * An upper bound on how long after its anchor any step of any sequence can still be on a row:
 * the largest step offset plus {@link SEQUENCE_SPAN_PADDING_DAYS} days (the weekend hold plus the
 * armable window). It bounds how far back a row read must reach.
 */
export function reminderSequenceSpanMs(): number {
  let largestOffsetMinutes = 0;
  for (const id of REMINDER_SEQUENCE_IDS) {
    for (const step of REMINDER_SEQUENCE_STEPS[id]) {
      largestOffsetMinutes = Math.max(largestOffsetMinutes, step.offsetMinutes);
    }
  }
  return largestOffsetMinutes * MS_PER_MINUTE + SEQUENCE_SPAN_PADDING_DAYS * MS_PER_DAY;
}
