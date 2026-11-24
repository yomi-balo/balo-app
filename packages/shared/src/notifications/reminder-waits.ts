import {
  REMINDER_ARMABLE_AFTER_DUE_MS,
  REMINDER_SEQUENCE_EXEMPT_FROM_DAILY_LIMIT,
  REMINDER_SEQUENCE_IDS,
  REMINDER_SEQUENCE_KEY_PREFIX,
  REMINDER_SEQUENCE_STEPS,
  reminderLocalDayStart,
  reminderStepSendTimes,
  type ReminderSequenceId,
  type ReminderStep,
} from './reminder-sequences';

/**
 * The wait-shaping rules for scheduled reminder rows: key parsing, grouping a sequence's rows
 * into one wait per (entity, recipient, anchor), "follow-ups finished", stalled, and sends today.
 * Pure: no db, no I/O. Every surface that reads these rows (the Lookup Follow-ups tab, the
 * stalled-proposal finder) goes through here so the rules have one definition.
 */

/** The fields of a `seq:{sequenceId}:{entityId}:{stepKey}:{userId}:{anchorIso}` key. */
export interface ReminderSequenceKeyParts {
  readonly sequenceId: ReminderSequenceId;
  readonly entityId: string;
  readonly stepKey: string;
  readonly userId: string;
  readonly anchorIso: string;
}

/** Skips after which a step's follow-up is gone for good: the wait itself carries on. */
export const REMINDER_FOLLOW_UP_GONE_SKIP_REASONS: readonly string[] = [
  'over_daily_limit',
  'anchor_moved',
];

/** A request is stalled once its last follow-up step was due more than this long ago. */
export const PROPOSAL_REVIEW_STALLED_AFTER_MS = 2 * 86_400_000;

const KEY_SEPARATOR = ':';

function isSequenceId(value: string): value is ReminderSequenceId {
  return (REMINDER_SEQUENCE_IDS as readonly string[]).includes(value);
}

/** True when `value` is an instant written exactly as `Date#toISOString` writes it. */
function isRoundTrippedIso(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

/**
 * Reads the next colon-delimited field from `key`, starting at `from`. A linear `indexOf` scan,
 * never a regex, so a crafted key cannot cost more than its length.
 */
function readField(key: string, from: number): { value: string; next: number } | null {
  const end = key.indexOf(KEY_SEPARATOR, from);
  if (end === -1) return null;
  return { value: key.slice(from, end), next: end + 1 };
}

/**
 * The inverse of `reminderSequenceKey`. `null` unless the key names a known sequence and one of
 * its steps, has a non-empty entity and user, and ends in an anchor written exactly as
 * `Date#toISOString` writes it. The anchor holds colons, so it is everything after the fifth
 * separator. Nothing is trimmed: a key that only parses after trimming is not one of ours.
 */
export function parseReminderSequenceKey(key: string): ReminderSequenceKeyParts | null {
  if (!key.startsWith(REMINDER_SEQUENCE_KEY_PREFIX)) return null;
  const sequence = readField(key, REMINDER_SEQUENCE_KEY_PREFIX.length);
  if (sequence === null || !isSequenceId(sequence.value)) return null;
  const entity = readField(key, sequence.next);
  if (entity === null || entity.value === '') return null;
  const step = readField(key, entity.next);
  if (step === null) return null;
  const user = readField(key, step.next);
  if (user === null || user.value === '') return null;

  const sequenceId = sequence.value;
  const anchorIso = key.slice(user.next);
  const knownStep = REMINDER_SEQUENCE_STEPS[sequenceId].some((s) => s.key === step.value);
  if (!knownStep || !isRoundTrippedIso(anchorIso)) return null;

  return {
    sequenceId,
    entityId: entity.value,
    stepKey: step.value,
    userId: user.value,
    anchorIso,
  };
}

/** The row facts the wait rules read. A superset row type passes straight through. */
export interface ReminderWaitRowFacts {
  readonly id: string;
  readonly dedupeKey: string;
  readonly status: string;
  readonly createdAt: Date;
  readonly publishedAt: Date | null;
  readonly scheduledFor: Date;
  readonly skipReason: string | null;
}

/** One recipient's wait on one entity at one anchor: the newest row for each step it has. */
export interface ReminderWait<R extends ReminderWaitRowFacts = ReminderWaitRowFacts> {
  readonly sequenceId: ReminderSequenceId;
  readonly entityId: string;
  readonly userId: string;
  readonly anchorIso: string;
  readonly steps: ReadonlyMap<string, R>;
}

function isNewer(candidate: ReminderWaitRowFacts, current: ReminderWaitRowFacts): boolean {
  const byTime = candidate.createdAt.getTime() - current.createdAt.getTime();
  if (byTime !== 0) return byTime > 0;
  return candidate.id > current.id;
}

function isShownRow(row: ReminderWaitRowFacts): boolean {
  if (row.status === 'cancelled') return false;
  return !(row.status === 'skipped' && row.skipReason === 'already_decided');
}

/**
 * Groups reminder rows into waits. Rows whose key does not parse, `cancelled` rows and
 * `already_decided` skips (the step was never in play) are dropped; a wait left with no step
 * does not exist. Each step keeps its newest row by `createdAt`, then `id`, so a re-armed key
 * shows its latest attempt. Waits come out in the order their first row appears.
 */
export function groupReminderWaits<R extends ReminderWaitRowFacts>(
  rows: readonly R[]
): ReminderWait<R>[] {
  const waits = new Map<string, { parts: ReminderSequenceKeyParts; steps: Map<string, R> }>();
  for (const row of rows) {
    if (!isShownRow(row)) continue;
    const parts = parseReminderSequenceKey(row.dedupeKey);
    if (parts === null) continue;
    const waitKey = [parts.sequenceId, parts.entityId, parts.userId, parts.anchorIso].join(
      KEY_SEPARATOR
    );
    let wait = waits.get(waitKey);
    if (wait === undefined) {
      wait = { parts, steps: new Map<string, R>() };
      waits.set(waitKey, wait);
    }
    const current = wait.steps.get(parts.stepKey);
    if (current === undefined || isNewer(row, current)) {
      wait.steps.set(parts.stepKey, row);
    }
  }
  return [...waits.values()].map(({ parts, steps }) => ({
    sequenceId: parts.sequenceId,
    entityId: parts.entityId,
    userId: parts.userId,
    anchorIso: parts.anchorIso,
    steps,
  }));
}

/** The facts a wait's send times and missed steps are read from. */
export interface ReminderWaitTiming {
  readonly sequenceId: ReminderSequenceId;
  readonly anchorIso: string;
  readonly steps: ReadonlyMap<string, unknown>;
}

/**
 * When each step of the wait's sequence is sent, keyed by step key. The same call the planner
 * makes (`reminderStepSendTimes` over `REMINDER_SEQUENCE_STEPS`), so a schedule shown to a person
 * and the step the sweep arms agree on the morning, including the same-morning bump.
 */
export function reminderWaitSendTimes(
  wait: Pick<ReminderWaitTiming, 'sequenceId' | 'anchorIso'>,
  zone: string
): ReadonlyMap<string, Date> {
  const times = reminderStepSendTimes({
    steps: REMINDER_SEQUENCE_STEPS[wait.sequenceId],
    anchor: new Date(wait.anchorIso),
    zone,
  });
  return new Map(times.map(({ stepKey, fireAt }) => [stepKey, fireAt]));
}

/**
 * True when `step` has no row and its send time (see `reminderWaitSendTimes`) is already more
 * than `REMINDER_ARMABLE_AFTER_DUE_MS` behind `now`: the planner will never arm it, so the
 * follow-up is gone. A step that has a row is never missed. The one definition of "missed", read
 * by the stalled finder and the Follow-ups tab alike.
 */
export function reminderStepMissed(
  wait: ReminderWaitTiming,
  step: ReminderStep,
  now: Date,
  zone: string
): boolean {
  if (wait.steps.has(step.key)) return false;
  const sendAt = reminderWaitSendTimes(wait, zone).get(step.key);
  if (sendAt === undefined) return false;
  return now.getTime() > sendAt.getTime() + REMINDER_ARMABLE_AFTER_DUE_MS;
}

function stepIsTerminal(row: ReminderWaitRowFacts | undefined): boolean {
  if (row === undefined) return false;
  if (row.status === 'published' || row.status === 'failed') return true;
  return (
    row.status === 'skipped' &&
    row.skipReason !== null &&
    REMINDER_FOLLOW_UP_GONE_SKIP_REASONS.includes(row.skipReason)
  );
}

/**
 * "Every follow-up has gone": each step of the wait's sequence has a row that is published,
 * failed, or skipped because the follow-up itself is gone, or has no row and was missed (see
 * `reminderStepMissed`). A pending or claimed step, a step still inside its window with no row
 * yet, or a skip that says the wait ended all leave it unfinished. `zone` is the recipient's.
 */
export function reminderWaitFollowUpsFinished(
  wait: ReminderWait,
  now: Date,
  zone: string
): boolean {
  return REMINDER_SEQUENCE_STEPS[wait.sequenceId].every(
    (step) => stepIsTerminal(wait.steps.get(step.key)) || reminderStepMissed(wait, step, now, zone)
  );
}

/** What the finder reports about a request's follow-ups once they have all gone. */
export interface ReminderWaitsLastStep<R extends ReminderWaitRowFacts = ReminderWaitRowFacts> {
  /** The latest step time across the waits (see `reminderWaitsLastStep`). */
  readonly at: Date;
  /** The row whose time is `at`; null when that step is a missed one with no row. */
  readonly row: R | null;
  /** Steps that were published. */
  readonly sent: number;
  /** Every step of every wait's sequence, whatever became of it. */
  readonly total: number;
}

/**
 * The latest step time across `waits`: `publishedAt` for a published row, else the row's
 * `scheduledFor`, and for a missed step with no row the planner send time (`reminderWaitSendTimes`,
 * the same helper `reminderStepMissed` reads). A step still inside its window with no row has no
 * time and is skipped. Also counts the steps sent against every step of each wait's sequence.
 * Null when no step has a time. `zoneOf` gives a wait's recipient zone.
 */
export function reminderWaitsLastStep<R extends ReminderWaitRowFacts>(
  waits: readonly ReminderWait<R>[],
  now: Date,
  zoneOf: (wait: ReminderWait<R>) => string
): ReminderWaitsLastStep<R> | null {
  let latest: { row: R | null; at: Date } | null = null;
  let sent = 0;
  let total = 0;
  const consider = (row: R | null, at: Date): void => {
    if (latest === null || at > latest.at) latest = { row, at };
  };
  for (const wait of waits) {
    const zone = zoneOf(wait);
    const sendTimes = reminderWaitSendTimes(wait, zone);
    for (const step of REMINDER_SEQUENCE_STEPS[wait.sequenceId]) {
      total += 1;
      const row = wait.steps.get(step.key);
      if (row === undefined) {
        const sendAt = sendTimes.get(step.key);
        if (sendAt !== undefined && reminderStepMissed(wait, step, now, zone)) {
          consider(null, sendAt);
        }
        continue;
      }
      if (row.status === 'published') sent += 1;
      consider(row, row.publishedAt ?? row.scheduledFor);
    }
  }
  const found = latest as { row: R | null; at: Date } | null;
  return found === null ? null : { ...found, sent, total };
}

/**
 * True when there is at least one wait, every wait is finished, and the latest step time across
 * them (`reminderWaitsLastStep`) is more than `afterMs` before `now`. Exactly `afterMs` is not
 * stalled. A request whose follow-ups were all skipped or missed stalls too: nothing more is
 * coming, whether or not anything went. A step still pending never stalls it. `zoneOf` gives a
 * wait's recipient zone, which places the steps that never got a row.
 */
export function reminderWaitsStalled<R extends ReminderWaitRowFacts>(
  waits: readonly ReminderWait<R>[],
  now: Date,
  afterMs: number,
  zoneOf: (wait: ReminderWait<R>) => string
): boolean {
  if (waits.length === 0) return false;
  if (!waits.every((wait) => reminderWaitFollowUpsFinished(wait, now, zoneOf(wait)))) return false;
  const last = reminderWaitsLastStep(waits, now, zoneOf);
  return last !== null && now.getTime() - last.at.getTime() > afterMs;
}

/** Plain-language name of each sequence, for admin copy. */
export const REMINDER_SEQUENCE_LABELS: Readonly<Record<ReminderSequenceId, string>> = {
  proposal_review: 'Proposal review follow-up',
  delivery_review: 'Delivery review follow-up',
  invitation: 'Invitation follow-up',
};

/**
 * `Proposal review follow-up, step 2` for a reminder-sequence key (`parseReminderSequenceKey`),
 * the step counted from 1 in the sequence's order. Null for any other key.
 */
export function reminderSequenceStepLabel(key: string): string | null {
  const parts = parseReminderSequenceKey(key);
  if (parts === null) return null;
  const index = REMINDER_SEQUENCE_STEPS[parts.sequenceId].findIndex((s) => s.key === parts.stepKey);
  return `${REMINDER_SEQUENCE_LABELS[parts.sequenceId]}, step ${String(index + 1)}`;
}

/**
 * How many reminder emails were published since local midnight in `zone`, counting only
 * sequences that are subject to the daily limit.
 */
export function reminderSentToday(
  rows: readonly Pick<ReminderWaitRowFacts, 'dedupeKey' | 'status' | 'publishedAt'>[],
  now: Date,
  zone: string
): number {
  const dayStart = reminderLocalDayStart(now, zone).getTime();
  let sent = 0;
  for (const row of rows) {
    if (row.status !== 'published' || row.publishedAt === null) continue;
    if (row.publishedAt.getTime() < dayStart) continue;
    const parts = parseReminderSequenceKey(row.dedupeKey);
    if (parts === null || REMINDER_SEQUENCE_EXEMPT_FROM_DAILY_LIMIT[parts.sequenceId]) continue;
    sent += 1;
  }
  return sent;
}
