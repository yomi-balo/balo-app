import { canonicalTimezone, zonedWallClockToUtc } from '../timezone';

export const REMINDER_SEQUENCE_IDS = ['proposal_review'] as const;
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
};

/** Names of the shared rules each sequence's finder must call rather than re-implement. */
export const REMINDER_SEQUENCE_SHARED_RULES: Readonly<
  Record<ReminderSequenceId, readonly string[]>
> = {
  proposal_review: ['proposalAwaitsClientReview'],
};

export const MAX_REMINDER_STEPS = 3;
export const REMINDER_DAILY_LIMIT = 2;
export const REMINDER_ARMABLE_AFTER_DUE_MS = 86_400_000;
export const REMINDER_DEFAULT_ZONE = 'Australia/Melbourne';
export const REMINDER_MORNING_HOUR = 9;
export const REMINDER_SEQUENCE_KEY_PREFIX = 'seq:';

const SATURDAY = 6;
const SUNDAY = 0;

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
