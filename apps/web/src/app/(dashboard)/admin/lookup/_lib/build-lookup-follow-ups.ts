import {
  REMINDER_DAILY_LIMIT,
  REMINDER_SEQUENCE_AUDIENCE,
  REMINDER_SEQUENCE_EXEMPT_FROM_DAILY_LIMIT,
  REMINDER_SEQUENCE_STEPS,
  groupReminderWaits,
  reminderRecipientZone,
  reminderSentToday,
  reminderStepMissed,
  reminderWaitFollowUpsFinished,
  reminderWaitSendTimes,
  type ReminderSequenceId,
  type ReminderStep,
  type ReminderWait,
} from '@balo/shared/notifications';
import { autoAcceptAt } from '@balo/shared/engagements';
import {
  EXEMPT_NOTE,
  REASON_CODE,
  REASON_SENTENCE,
  SEQUENCE_META,
  isFollowUpReasonKey,
  sequenceChannelLabel,
  type FollowUpLens,
  type FollowUpReasonKey,
  type FollowUpStepState,
  type FollowUpStepView,
  type FollowUpWaitState,
  type FollowUpWaitView,
  type LookupFollowUpsView,
} from './follow-ups-view';

/**
 * BAL-666 — turns reminder rows, the live "is it still waiting" answer, and `now` into the
 * Follow-ups tab's view. PURE: no I/O, no `@balo/db` import (the invariant pins that), every
 * wait-shaping rule delegated to `@balo/shared/notifications`.
 *
 * The view carries words, never rows: the stored `payload` is read here for a title and a count
 * and goes no further.
 */

/** The row facts this builder reads. `ReminderWaitRow` (`@balo/db`) satisfies it structurally. */
export interface FollowUpSourceRow {
  readonly id: string;
  readonly dedupeKey: string;
  readonly status: string;
  readonly scheduledFor: Date;
  readonly publishedAt: Date | null;
  readonly skipReason: string | null;
  readonly lastError: string | null;
  readonly attempts: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly recipient: {
    readonly firstName: string | null;
    readonly lastName: string | null;
    readonly timezone: string | null;
  } | null;
  /** `null` when the row's subject is gone; each field is `null` when that fact does not exist. */
  readonly entity: {
    readonly title: string | null;
    readonly companyName: string | null;
    readonly agencyName: string | null;
  } | null;
}

/** What the live source says about one entity's wait right now. */
export interface LiveWait {
  readonly anchorIso: string;
  /** How many proposals await review; `null` for a sequence that has no such count. */
  readonly awaitingCount: number | null;
  /** The subject's live title; `null` when the sequence's source does not carry one. */
  readonly title: string | null;
}

/** The map key for a live wait. */
export function liveWaitKey(sequenceId: ReminderSequenceId, entityId: string): string {
  return `${sequenceId}:${entityId}`;
}

export interface BuildFollowUpsInput {
  readonly lens: FollowUpLens;
  readonly rows: readonly FollowUpSourceRow[];
  readonly live: ReadonlyMap<string, LiveWait>;
  /** The person's first name and saved zone on a person lens. */
  readonly subject: { readonly firstName: string | null; readonly timezone: string | null } | null;
  readonly origin: { readonly requestTitle: string } | null;
  readonly now: Date;
}

export const FOLLOW_UPS_EARLIER_DAYS = 90;
const MS_PER_DAY = 86_400_000;
const MS_PER_MINUTE = 60_000;
const FORMER_USER = 'A former user';
const ORDINALS: readonly string[] = ['1st', '2nd', '3rd'];

/** Skips that say the wait itself ended. */
const WAIT_ENDED_SKIPS: ReadonlySet<string> = new Set([
  'no_longer_waiting',
  'recipient_gone',
  'malformed_payload',
]);

type FormatKind = 'day' | 'dayTime';

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string, kind: FormatKind): Intl.DateTimeFormat {
  const cacheKey = `${zone}|${kind}`;
  const cached = FORMATTERS.get(cacheKey);
  if (cached !== undefined) return cached;
  const options: Intl.DateTimeFormatOptions =
    kind === 'day'
      ? { weekday: 'short', day: 'numeric', month: 'short', timeZone: zone }
      : {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
          timeZone: zone,
        };
  const formatter = new Intl.DateTimeFormat('en-AU', options);
  FORMATTERS.set(cacheKey, formatter);
  return formatter;
}

function partsOf(date: Date, zone: string, kind: FormatKind): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of formatterFor(zone, kind).formatToParts(date)) {
    map.set(part.type, part.value);
  }
  return map;
}

/** `Mon 16 Nov`. */
function formatDay(date: Date, zone: string): string {
  const p = partsOf(date, zone, 'day');
  return `${p.get('weekday')} ${p.get('day')} ${p.get('month')}`;
}

/** `Wed 18 Nov, 9:00 am`, in the recipient's zone. */
function formatDayTime(date: Date, zone: string): string {
  const p = partsOf(date, zone, 'dayTime');
  const period = (p.get('dayPeriod') ?? '').toLowerCase();
  return `${p.get('weekday')} ${p.get('day')} ${p.get('month')}, ${p.get('hour')}:${p.get('minute')} ${period}`;
}

/** The local calendar day of `date` in `zone`, as a whole-day count. */
function localDayNumber(date: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(date);
  const read = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? Number.NaN);
  return Math.round(Date.UTC(read('year'), read('month') - 1, read('day')) / MS_PER_DAY);
}

function weekdayName(date: Date, zone: string): string {
  return new Intl.DateTimeFormat('en-AU', { weekday: 'long', timeZone: zone }).format(date);
}

function offsetLabel(step: ReminderStep): string {
  const days = step.offsetMinutes / 1440;
  const base = `${days} ${days === 1 ? 'day' : 'days'} after`;
  return step.timing === 'exact' ? `${base}, exact time` : base;
}

function ordinalOf(index: number): string {
  return ORDINALS[index] ?? `${index + 1}th`;
}

function pluralProposals(count: number): string {
  return `${count} ${count === 1 ? 'proposal' : 'proposals'}`;
}

function readCount(payload: Readonly<Record<string, unknown>>): number | null {
  const value = payload['awaitingCount'];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readTitle(payload: Readonly<Record<string, unknown>>): string | null {
  const value = payload['title'];
  return typeof value === 'string' && value !== '' ? value : null;
}

function newestRow(wait: ReminderWait<FollowUpSourceRow>): FollowUpSourceRow | undefined {
  let newest: FollowUpSourceRow | undefined;
  for (const row of wait.steps.values()) {
    if (
      newest === undefined ||
      row.createdAt.getTime() > newest.createdAt.getTime() ||
      (row.createdAt.getTime() === newest.createdAt.getTime() && row.id > newest.id)
    ) {
      newest = row;
    }
  }
  return newest;
}

function latestUpdate(wait: ReminderWait<FollowUpSourceRow>): number {
  let latest = 0;
  for (const row of wait.steps.values()) {
    latest = Math.max(latest, row.updatedAt.getTime());
  }
  return latest;
}

function waitState(
  wait: ReminderWait<FollowUpSourceRow>,
  live: LiveWait | undefined,
  newest: FollowUpSourceRow | undefined,
  now: Date,
  zone: string
): FollowUpWaitState {
  const newestSkipReason = newest?.status === 'skipped' ? newest.skipReason : null;
  const newestEnded = newestSkipReason !== null && WAIT_ENDED_SKIPS.has(newestSkipReason);
  if (live?.anchorIso !== wait.anchorIso || newestEnded) return 'stopped';
  if (!reminderWaitFollowUpsFinished(wait, now, zone)) return 'waiting';
  return SEQUENCE_META[wait.sequenceId].endsAutomatically ? 'waiting' : 'finished';
}

const WEEKEND_WEEKDAYS: ReadonlySet<string> = new Set(['Saturday', 'Sunday']);

/**
 * Says so when a morning step was held past its due day: it fell due on a weekend, or the send
 * moved on by more than the usual next morning (a Friday afternoon due goes out Monday).
 */
function heldNote(step: ReminderStep, dueAt: Date, sendAt: Date, zone: string): string | null {
  if (step.timing !== 'weekday_morning') return null;
  const dueDay = weekdayName(dueAt, zone);
  const gapDays = localDayNumber(sendAt, zone) - localDayNumber(dueAt, zone);
  if (gapDays <= 1 && !WEEKEND_WEEKDAYS.has(dueDay)) return null;
  if (gapDays === 0) return null;
  return `Fell due on ${dueDay}. Held to ${weekdayName(sendAt, zone)} morning.`;
}

interface StepFacts {
  readonly state: FollowUpStepState;
  readonly channel: string | null;
  readonly reasonKey: FollowUpReasonKey | null;
  readonly unknownSkipCode: string | null;
  readonly detail: string | null;
  readonly whenLabel: string;
}

function factsForRow(row: FollowUpSourceRow, zone: string, channel: string): StepFacts {
  if (row.status === 'published') {
    return {
      state: 'sent',
      channel,
      reasonKey: null,
      unknownSkipCode: null,
      detail: null,
      whenLabel: formatDayTime(row.publishedAt ?? row.scheduledFor, zone),
    };
  }
  if (row.status === 'failed') {
    const cause = row.lastError === null ? '' : `${row.lastError.slice(0, 200)} `;
    return {
      state: 'failed',
      channel: null,
      reasonKey: 'send_failed',
      unknownSkipCode: null,
      detail: `${cause}Also on admin Home.`,
      whenLabel: formatDayTime(row.scheduledFor, zone),
    };
  }
  if (row.status === 'skipped') {
    const code = row.skipReason ?? '';
    const known = isFollowUpReasonKey(code);
    return {
      state: 'not_sent',
      channel: null,
      reasonKey: known ? code : null,
      unknownSkipCode: known ? null : code,
      detail: null,
      whenLabel: `Was due ${formatDayTime(row.scheduledFor, zone)}`,
    };
  }
  return {
    state: 'due',
    channel: null,
    reasonKey: null,
    unknownSkipCode: null,
    detail: null,
    whenLabel: formatDayTime(row.scheduledFor, zone),
  };
}

function factsForMissingStep(sendAt: Date, missed: boolean, zone: string): StepFacts {
  if (missed) {
    return {
      state: 'not_sent',
      channel: null,
      reasonKey: 'missed',
      unknownSkipCode: null,
      detail: null,
      whenLabel: `Was due ${formatDayTime(sendAt, zone)}`,
    };
  }
  return {
    state: 'due',
    channel: null,
    reasonKey: null,
    unknownSkipCode: null,
    detail: null,
    whenLabel: formatDayTime(sendAt, zone),
  };
}

function sentenceFor(
  facts: StepFacts,
  first: string,
  attempts: number
): { sentence: string | null; code: string | null } {
  if (facts.reasonKey !== null) {
    return {
      sentence: REASON_SENTENCE[facts.reasonKey](first, attempts),
      code: REASON_CODE[facts.reasonKey],
    };
  }
  if (facts.unknownSkipCode !== null) {
    return { sentence: 'It was not sent.', code: facts.unknownSkipCode };
  }
  return { sentence: null, code: null };
}

interface StepContext {
  readonly wait: ReminderWait<FollowUpSourceRow>;
  readonly anchor: Date;
  readonly zone: string;
  readonly first: string;
  readonly now: Date;
  readonly includeMissing: boolean;
  /** When each step of this wait is sent, as the planner places it. */
  readonly sendTimes: ReadonlyMap<string, Date>;
}

function buildStep(step: ReminderStep, index: number, ctx: StepContext): FollowUpStepView | null {
  const { wait, anchor, zone, first, now } = ctx;
  const row = wait.steps.get(step.key);
  if (row === undefined && !ctx.includeMissing) return null;
  const dueAt = new Date(anchor.getTime() + step.offsetMinutes * MS_PER_MINUTE);
  const sendAt = ctx.sendTimes.get(step.key) ?? dueAt;
  const channel = sequenceChannelLabel(wait.sequenceId);
  const facts =
    row === undefined
      ? factsForMissingStep(sendAt, reminderStepMissed(wait, step, now, zone), zone)
      : factsForRow(row, zone, channel);
  const { sentence, code } = sentenceFor(facts, first, row?.attempts ?? 0);
  return {
    key: step.key,
    ordinal: ordinalOf(index),
    offsetLabel: offsetLabel(step),
    state: facts.state,
    channel: facts.channel,
    sentence,
    code,
    detail: facts.detail,
    held: heldNote(step, dueAt, sendAt, zone),
    whenLabel: facts.whenLabel,
  };
}

/** `total` is the sequence's step count, so a stopped wait that shows fewer rows still reads "of 3". */
function summarise(steps: readonly FollowUpStepView[], total: number): string {
  const count = (state: FollowUpStepState): number => steps.filter((s) => s.state === state).length;
  const parts = [`${count('sent')} of ${total} sent`];
  if (count('not_sent') > 0) parts.push(`${count('not_sent')} not sent`);
  if (count('failed') > 0) parts.push(`${count('failed')} failed`);
  const next = steps.find((s) => s.state === 'due');
  if (next !== undefined) parts.push(`next ${next.whenLabel}`);
  return parts.join(' · ');
}

function personName(row: FollowUpSourceRow | undefined): string {
  const recipient = row?.recipient;
  if (recipient === null || recipient === undefined) return FORMER_USER;
  const name = [recipient.firstName, recipient.lastName].filter(Boolean).join(' ');
  return name === '' ? FORMER_USER : name;
}

interface FactContext {
  readonly lens: FollowUpLens;
  readonly state: FollowUpWaitState;
  readonly anchor: Date;
  readonly zone: string;
  readonly now: Date;
  readonly awaitingCount: number | null;
  readonly entity: FollowUpSourceRow['entity'];
}

/** The one-line fact each sequence shows beside its title, or `null` when there is nothing to say. */
const SEQUENCE_FACT: Readonly<Record<ReminderSequenceId, (ctx: FactContext) => string | null>> = {
  proposal_review: (ctx) =>
    ctx.awaitingCount === null ? null : pluralProposals(ctx.awaitingCount),
  delivery_review: (ctx) => {
    if (ctx.state === 'stopped') return null;
    const acceptAt = autoAcceptAt(ctx.anchor);
    // The sweep may not have closed a due wait yet, so a past date is never reported as accepted.
    const verb = acceptAt.getTime() <= ctx.now.getTime() ? 'Auto-accept was due' : 'Auto-accepts';
    return `${verb} ${formatDay(acceptAt, ctx.zone)}`;
  },
  invitation: (ctx) => {
    if (ctx.lens === 'person') {
      return ctx.entity?.companyName == null ? null : `From ${ctx.entity.companyName}`;
    }
    return ctx.entity !== null && ctx.entity.agencyName === null ? 'Independent expert' : null;
  },
};

/** The party a wait is waiting on, beside the person's name: the company or the expert's agency. */
function partyOf(
  sequenceId: ReminderSequenceId,
  entity: FollowUpSourceRow['entity']
): string | null {
  if (entity === null) return null;
  return REMINDER_SEQUENCE_AUDIENCE[sequenceId] === 'client'
    ? entity.companyName
    : entity.agencyName;
}

function buildWait(
  wait: ReminderWait<FollowUpSourceRow>,
  lens: FollowUpLens,
  live: LiveWait | undefined,
  now: Date
): { view: FollowUpWaitView; state: FollowUpWaitState; anchor: Date; updatedAt: number } | null {
  const newest = newestRow(wait);
  if (newest === undefined) return null;
  const zone = reminderRecipientZone(newest.recipient?.timezone);
  const state = waitState(wait, live, newest, now, zone);
  const anchor = new Date(wait.anchorIso);
  const first = newest.recipient?.firstName ?? 'The recipient';
  const sendTimes = reminderWaitSendTimes(wait, zone);
  const ctx: StepContext = {
    wait,
    anchor,
    zone,
    first,
    now,
    includeMissing: state !== 'stopped',
    sendTimes,
  };
  const sequenceSteps = REMINDER_SEQUENCE_STEPS[wait.sequenceId];
  const steps = sequenceSteps
    .map((step, index) => buildStep(step, index, ctx))
    .filter((s): s is FollowUpStepView => s !== null);

  const meta = SEQUENCE_META[wait.sequenceId];
  const fact = SEQUENCE_FACT[wait.sequenceId]({
    lens,
    state,
    anchor,
    zone,
    now,
    awaitingCount: live?.awaitingCount ?? readCount(newest.payload),
    entity: newest.entity,
  });
  const sincePhrase = state === 'stopped' ? meta.sinceStopped : meta.sinceLive;
  const since = `${sincePhrase} ${formatDay(anchor, zone)}`;
  const entityTitle =
    live?.title ?? newest.entity?.title ?? readTitle(newest.payload) ?? meta.untitled;
  const party = partyOf(wait.sequenceId, newest.entity);
  const person = personName(newest);

  const personAtParty = party === null ? person : `${person} @ ${party}`;
  const headline = lens === 'person' ? entityTitle : personAtParty;
  const context = lens === 'person' ? [meta.aboutType, fact, since] : [fact, since];

  return {
    view: {
      id: newest.id,
      title: meta.title,
      headline,
      context: context.filter((part): part is string => part !== null),
      state,
      summary: summarise(steps, sequenceSteps.length),
      note: REMINDER_SEQUENCE_EXEMPT_FROM_DAILY_LIMIT[wait.sequenceId] ? EXEMPT_NOTE : null,
      hasFailed: steps.some((s) => s.state === 'failed'),
      steps,
    },
    state,
    anchor,
    updatedAt: latestUpdate(wait),
  };
}

/** Everything the Follow-ups tab shows, from the rows already read. */
export function buildLookupFollowUps(input: BuildFollowUpsInput): LookupFollowUpsView {
  const { lens, rows, live, subject, origin, now } = input;
  const waits = groupReminderWaits(rows);
  const built = waits
    .map((wait) =>
      buildWait(wait, lens, live.get(liveWaitKey(wait.sequenceId, wait.entityId)), now)
    )
    .filter((b): b is NonNullable<typeof b> => b !== null);

  const earlierCutoff = now.getTime() - FOLLOW_UPS_EARLIER_DAYS * MS_PER_DAY;
  const current = built
    .filter((b) => b.state !== 'stopped')
    .sort((a, b) => a.anchor.getTime() - b.anchor.getTime());
  const earlier = built
    .filter((b) => b.state === 'stopped' && b.updatedAt >= earlierCutoff)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const firstName = lens === 'person' ? (subject?.firstName ?? null) : null;
  return {
    lens,
    subjectFirstName: firstName,
    origin,
    limit: lens === 'person' ? limitFor(rows, subject?.timezone ?? null, now) : null,
    now: current.map((b) => b.view),
    earlier: earlier.map((b) => b.view),
  };
}

function limitFor(
  rows: readonly FollowUpSourceRow[],
  timezone: string | null,
  now: Date
): { used: number; of: number; full: boolean } {
  const used = reminderSentToday(rows, now, reminderRecipientZone(timezone));
  return { used, of: REMINDER_DAILY_LIMIT, full: used >= REMINDER_DAILY_LIMIT };
}
