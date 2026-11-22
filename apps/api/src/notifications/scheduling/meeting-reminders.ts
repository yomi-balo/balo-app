/**
 * BAL-658 — PRE-CALL REMINDERS FOR BOOKED CONSULTATIONS, AND THEIR FIRE-TIME GUARD.
 *
 * The lifecycle sweep arms up to six ADR-1047 promises per booked meeting: the offsets of
 * `MEETING_REMINDER_OFFSETS` (24h, 1h, 30m before the start), each for the client and for the
 * expert. {@link meetingReminderRecheck} re-reads live state at fire time, rebuilds the single
 * recipient and publishes `meeting.reminder_to_client` / `meeting.reminder_to_expert`; the engine's
 * rules map the offset to channels. Nothing here sends anything.
 *
 * ── ⚠ THE ARM RULE ────────────────────────────────────────────────────────────────────────────
 * An offset is armed only while its fire time `start − beforeStartMs` lies in
 * `[now − TOLERANCE, now + LEAD]` ({@link armWindowFor}). TOLERANCE is one sweep interval plus one
 * of slack for tick duration and jitter; LEAD lets the dispatch tick fire on time. A meeting booked
 * 3h out never enters the 24h window, so it gets only 1h and 30m. A reschedule changes the start,
 * hence the key, so the new start gets every offset still in or ahead of its window. Residual: a
 * sweep outage longer than TOLERANCE drops the reminders whose fire time passed during it — a late
 * reminder is worse than none.
 * One narrow start window per offset (not one scan of the day) is what keeps a busy day from
 * starving a meeting that is hours away.
 *
 * ── ⚠ ONE PROMISE PER (MEETING, OFFSET, AUDIENCE, START) — THE KEY'S HISTORY, NOT THE KEY ─────
 * The dedupe key folds only onto PENDING rows, so a fired promise would be armed again on the next
 * tick. The arm site and the recheck both read the key's history through `isScheduledKeyDecided`;
 * only {@link REARMABLE_MEETING_REMINDER_SKIP_REASONS} may be armed again (a call moved away and
 * back must remind again). Every other skip is final.
 *
 * ── ⚠ RECIPIENTS ARE ONE PERSON, NEVER A ROLE ────────────────────────────────────────────────
 * Client → the booker, while they still participate. Expert → the delivering expert's own user.
 * `correlationId` is a FRESH uuid PER PROMISE (see `meeting-absence.ts`).
 *
 * ── ⚠ THE PUBLISHED PAYLOAD IS BUILT FIELD BY FIELD, NEVER SPREAD ───────────────────────────
 * A stray `userId` on the stored row would reach the dispatcher's `self` resolution, so the guard
 * publishes exactly the {@link MeetingReminderPayload} keys. The owning company and expert are
 * re-resolved from the meeting's own primary context at fire time and COMPARED with the payload.
 * ⚠ No counterparty address anywhere in the payload: names only.
 */
import { randomUUID } from 'node:crypto';
import {
  companiesRepository,
  meetingContextsRepository,
  meetingsRepository,
  resolveMeetingContextOwner,
  scheduledNotificationsRepository,
  type Meeting,
} from '@balo/db';
import { MEETING_SERVER_EVENTS, trackServer } from '@balo/analytics/server';
import { createLogger } from '@balo/shared/logging';
import {
  selectPrimaryMeetingContext,
  type MeetingContextOwner,
  type PrimaryMeetingContext,
} from '@balo/shared/meetings';
import { meetingOrigin } from '../../services/call-now/meeting-origin.js';
import {
  CALENDAR_CONTEXT_REGISTRY,
  type CalendarProjectedContextType,
} from '../../services/consultation-events/calendar-context-registry.js';
import { memberCallPath } from '../../services/consultation-events/member-call-url.js';
import {
  deliveringContextOwnerForMeeting,
  deliveringPartyName,
} from '../../services/meetings/delivering-party.js';
import { resolveMeetingPagePath } from '../../services/meetings/meeting-page-path.js';
import {
  MEETING_REMINDER_OFFSETS,
  type MeetingReminderAudience,
  type MeetingReminderEvent,
  type MeetingReminderOffset,
  type MeetingReminderPayload,
} from '../events.js';
import { isCaseNoLongerActive, meetingIdFrom } from './meeting-absence.js';
import {
  resolveMeetingSingleRecipient,
  smsIneligibilityHoursOpen,
  type SmsIneligibleReason,
} from './meeting-single-recipient.js';
import type { RecheckResult, ScheduledRecheck } from './rechecks.js';
import { scheduleNotification } from './schedule.js';
import { isScheduledKeyDecided, scheduledKeyDecided } from './scheduled-key-decided.js';

const log = createLogger('meeting-reminder-scheduling');

/** The registry key for the reminder guard. ⚠ Must match `SCHEDULED_RECHECKS`. */
export const MEETING_REMINDER_RECHECK = 'meeting_reminder';

/** How far ahead of its fire time an offset is armed — lets the dispatch tick fire on time. */
export const MEETING_REMINDER_ARM_LEAD_MS = 5 * 60_000;

/**
 * How far past its fire time an offset may still be armed: one sweep interval plus one of slack
 * for tick duration and jitter. Later than that, the reminder is dropped, not sent late.
 */
export const MEETING_REMINDER_ARM_TOLERANCE_MS = 2 * 60_000;

/** Per-offset read bound. ⚠ The sweep warns when a read fills it. */
export const MEETING_REMINDER_BATCH_LIMIT = 200;

/** Every skip the reminder guard records besides the SMS gate's own reasons. */
export const MEETING_REMINDER_SKIP_REASONS = [
  'malformed_payload',
  'meeting_missing',
  'not_scheduled',
  'start_moved',
  'call_now',
  'already_decided',
  'case_closed',
  'owner_unresolved',
  'owner_mismatch',
  'no_booker',
  'no_expert',
] as const;
export type MeetingReminderSkipReason =
  | (typeof MEETING_REMINDER_SKIP_REASONS)[number]
  | SmsIneligibleReason;

/**
 * The skips after which the promise may be armed again: the call moved away from this start (and
 * may move back), or a sibling's decision has since been cleared. Every other skip is final.
 */
export const REARMABLE_MEETING_REMINDER_SKIP_REASONS: readonly MeetingReminderSkipReason[] = [
  'start_moved',
  'already_decided',
];

const AUDIENCE_BY_EVENT = {
  'meeting.reminder_to_client': 'client',
  'meeting.reminder_to_expert': 'expert',
} as const satisfies Record<MeetingReminderEvent, MeetingReminderAudience>;

const EVENT_BY_AUDIENCE = {
  client: 'meeting.reminder_to_client',
  expert: 'meeting.reminder_to_expert',
} as const satisfies Record<MeetingReminderAudience, MeetingReminderEvent>;

const AUDIENCES: readonly MeetingReminderAudience[] = ['client', 'expert'];
const OFFSETS = Object.keys(MEETING_REMINDER_OFFSETS) as MeetingReminderOffset[];

/** Dedup + history handle: one promise per meeting, offset, audience and start. */
export function meetingReminderKey(
  meetingId: string,
  offset: MeetingReminderOffset,
  audience: MeetingReminderAudience,
  scheduledStartIso: string
): string {
  return `meeting_reminder:${meetingId}:${offset}:${audience}:${scheduledStartIso}`;
}

/**
 * The start window in which `offset` is armed: meetings whose fire time lies in
 * `[now − TOLERANCE, now + LEAD]`.
 */
export function armWindowFor(
  offset: MeetingReminderOffset,
  now: Date
): { startFrom: Date; startTo: Date } {
  const { beforeStartMs } = MEETING_REMINDER_OFFSETS[offset];
  return {
    startFrom: new Date(now.getTime() - MEETING_REMINDER_ARM_TOLERANCE_MS + beforeStartMs),
    startTo: new Date(now.getTime() + MEETING_REMINDER_ARM_LEAD_MS + beforeStartMs),
  };
}

function isDecided(key: string, excludeId?: string): Promise<boolean> {
  return isScheduledKeyDecided(key, REARMABLE_MEETING_REMINDER_SKIP_REASONS, excludeId);
}

interface ArmTally {
  armed: number;
  alreadyPending: number;
}

interface ArmTarget {
  readonly meetingId: string;
  readonly scheduledStart: Date;
  readonly offset: MeetingReminderOffset;
}

async function armAudience(
  target: ArmTarget,
  audience: MeetingReminderAudience,
  owner: MeetingContextOwner,
  tally: ArmTally
): Promise<void> {
  const startIso = target.scheduledStart.toISOString();
  const key = meetingReminderKey(target.meetingId, target.offset, audience, startIso);
  const payload: MeetingReminderPayload = {
    correlationId: randomUUID(),
    meetingId: target.meetingId,
    scheduledStartIso: startIso,
    offset: target.offset,
    companyId: owner.companyId,
    expertProfileId: owner.expertProfileId,
    // Seeded, then REBUILT by the guard at fire time.
    recipientUserId: null,
    recipientTimeZone: null,
    counterpartyName: null,
    callLabel: null,
    contextType: null,
    durationMinutes: null,
    joinPath: null,
    reschedulePath: null,
  };
  const { outcome } = await scheduleNotification(EVENT_BY_AUDIENCE[audience], payload, {
    key,
    at: new Date(
      target.scheduledStart.getTime() - MEETING_REMINDER_OFFSETS[target.offset].beforeStartMs
    ),
    mode: 'first_wins',
    recheck: MEETING_REMINDER_RECHECK,
  });
  if (outcome === 'already_pending') {
    tally.alreadyPending += 1;
  } else {
    tally.armed += 1;
  }
}

/** The audiences with a person to remind: the expert side needs a named delivering expert. */
function audiencesFor(owner: MeetingContextOwner): MeetingReminderAudience[] {
  return AUDIENCES.filter((audience) => audience === 'client' || owner.expertProfileId !== null);
}

interface AudienceHistory {
  readonly audience: MeetingReminderAudience;
  /** A live promise already waits for this key. */
  readonly pending: boolean;
  /** The key's history says it fired or was finally skipped. */
  readonly decided: boolean;
  /** A stored promise for this key was armed for a meeting that names no expert. */
  readonly namesNoExpert: boolean;
}

function payloadNamesNoExpert(payload: Record<string, unknown> | undefined): boolean {
  return payload?.expertProfileId === null;
}

async function audienceHistory(
  target: ArmTarget,
  audience: MeetingReminderAudience
): Promise<AudienceHistory> {
  const key = meetingReminderKey(
    target.meetingId,
    target.offset,
    audience,
    target.scheduledStart.toISOString()
  );
  const rows = await scheduledNotificationsRepository.findByDedupeKey(key);
  return {
    audience,
    pending: rows.some((row) => row.status === 'pending'),
    decided: scheduledKeyDecided(rows, REARMABLE_MEETING_REMINDER_SKIP_REASONS),
    namesNoExpert: rows.some((row) => payloadNamesNoExpert(row.payload)),
  };
}

/**
 * The audiences still to arm, read from each key's history before any other lookup: one with a
 * pending promise or a decided history needs nothing. The expert audience is dropped once a stored
 * promise shows the meeting names no expert.
 */
async function audiencesToArm(target: ArmTarget): Promise<MeetingReminderAudience[]> {
  const histories = await Promise.all(
    AUDIENCES.map((audience) => audienceHistory(target, audience))
  );
  const noExpert = histories.some((history) => history.namesNoExpert);
  return histories
    .filter((history) => !history.pending && !history.decided)
    .filter((history) => history.audience === 'client' || !noExpert)
    .map((history) => history.audience);
}

async function armMeeting(target: ArmTarget, tally: ArmTally): Promise<void> {
  const toArm = await audiencesToArm(target);
  if (toArm.length === 0) {
    return;
  }
  if ((await meetingOrigin(target.meetingId)) === 'call_now') {
    return;
  }
  const owner = await deliveringContextOwnerForMeeting(target.meetingId);
  if (owner === null) {
    log.info(
      { meetingId: target.meetingId, offset: target.offset },
      'Meeting reminder not armed: owner unresolved'
    );
    return;
  }
  const armable = new Set(audiencesFor(owner));
  for (const audience of toArm.filter((candidate) => armable.has(candidate))) {
    await armAudience(target, audience, owner, tally);
  }
}

async function armOffset(offset: MeetingReminderOffset, now: Date): Promise<void> {
  const window = armWindowFor(offset, now);
  const meetings = await meetingsRepository.listScheduledStartingBetween({
    ...window,
    limit: MEETING_REMINDER_BATCH_LIMIT,
  });
  if (meetings.length === MEETING_REMINDER_BATCH_LIMIT) {
    log.warn(
      { offset, limit: MEETING_REMINDER_BATCH_LIMIT },
      'Meeting reminder batch FILLED — meetings were dropped from this tick'
    );
  }
  const tally: ArmTally = { armed: 0, alreadyPending: 0 };
  for (const meeting of meetings) {
    try {
      await armMeeting(
        { meetingId: meeting.id, scheduledStart: meeting.scheduledStart, offset },
        tally
      );
    } catch (error) {
      log.warn(
        {
          meetingId: meeting.id,
          offset,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        'Meeting reminder arm failed — the next tick retries'
      );
    }
  }
  if (meetings.length > 0) {
    log.info({ offset, meetings: meetings.length, ...tally }, 'Meeting reminders armed');
  }
}

/**
 * ARM every reminder whose fire time is within the arm window. Called by the lifecycle sweep once
 * per tick. A failure in one offset's read propagates to the sweep, which logs it; a failure on one
 * meeting is logged and retried next tick.
 */
export async function armMeetingReminders(now: Date): Promise<void> {
  for (const offset of OFFSETS) {
    await armOffset(offset, now);
  }
}

interface ParsedReminderRow {
  readonly meetingId: string;
  readonly audience: MeetingReminderAudience;
  readonly offset: MeetingReminderOffset;
  readonly correlationId: string;
  readonly scheduledStartIso: string;
  readonly companyId: string;
  readonly expertProfileId: string | null;
}

function isOffset(value: unknown): value is MeetingReminderOffset {
  return typeof value === 'string' && Object.hasOwn(MEETING_REMINDER_OFFSETS, value);
}

function audienceFromEvent(event: string): MeetingReminderAudience | null {
  return Object.hasOwn(AUDIENCE_BY_EVENT, event)
    ? AUDIENCE_BY_EVENT[event as MeetingReminderEvent]
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseReminderRow(row: Parameters<ScheduledRecheck>[0]): ParsedReminderRow | null {
  const meetingId = meetingIdFrom(row.payload);
  const audience = audienceFromEvent(row.event);
  const { offset } = row.payload;
  const correlationId = nonEmptyString(row.payload.correlationId);
  const scheduledStartIso = nonEmptyString(row.payload.scheduledStartIso);
  const companyId = nonEmptyString(row.payload.companyId);
  if (
    meetingId === null ||
    audience === null ||
    !isOffset(offset) ||
    correlationId === null ||
    scheduledStartIso === null ||
    companyId === null
  ) {
    return null;
  }
  return {
    meetingId,
    audience,
    offset,
    correlationId,
    scheduledStartIso,
    companyId,
    expertProfileId: nonEmptyString(row.payload.expertProfileId),
  };
}

function skip(reason: MeetingReminderSkipReason): RecheckResult {
  return { publish: false, reason };
}

/** The meeting's own state: still booked, and still at the start this promise was armed for. */
function meetingStateSkip(
  meeting: Meeting,
  parsed: ParsedReminderRow
): MeetingReminderSkipReason | null {
  if (meeting.status !== 'scheduled') {
    return 'not_scheduled';
  }
  return meeting.scheduledStart.toISOString() === parsed.scheduledStartIso ? null : 'start_moved';
}

/** The skips that need a further read, cheapest first. */
async function liveStateSkip(
  parsed: ParsedReminderRow,
  rowId: string
): Promise<MeetingReminderSkipReason | null> {
  if ((await meetingOrigin(parsed.meetingId)) === 'call_now') {
    return 'call_now';
  }
  const key = meetingReminderKey(
    parsed.meetingId,
    parsed.offset,
    parsed.audience,
    parsed.scheduledStartIso
  );
  if (await isDecided(key, rowId)) {
    return 'already_decided';
  }
  return (await isCaseNoLongerActive(parsed.meetingId)) ? 'case_closed' : null;
}

interface ResolvedOwner {
  readonly primary: PrimaryMeetingContext;
  readonly owner: MeetingContextOwner;
}

/** ⚠ THE MEETING NAMES ITS OWNER — the primary context is read once and resolved. */
async function resolveOwner(meetingId: string): Promise<ResolvedOwner | null> {
  const selected = selectPrimaryMeetingContext(
    await meetingContextsRepository.listByMeeting(meetingId)
  );
  if (!selected.ok) {
    return null;
  }
  const owner = await resolveMeetingContextOwner(selected.context);
  return owner === undefined ? null : { primary: selected.context, owner };
}

async function counterpartyNameFor(
  audience: MeetingReminderAudience,
  parsed: ParsedReminderRow,
  owner: MeetingContextOwner
): Promise<string | null> {
  if (audience === 'client') {
    return deliveringPartyName(owner);
  }
  const company = await companiesRepository.findNameById(parsed.companyId);
  return company?.name ?? null;
}

/** The context's event label ("Consultation"), or `null` for a context the registry does not name. */
function callLabelFor(contextType: string): string | null {
  return Object.hasOwn(CALENDAR_CONTEXT_REGISTRY, contextType)
    ? (CALENDAR_CONTEXT_REGISTRY[contextType as CalendarProjectedContextType]?.eventLabel ?? null)
    : null;
}

function durationMinutesOf(meeting: Meeting): number {
  return Math.round((meeting.scheduledEnd.getTime() - meeting.scheduledStart.getTime()) / 60_000);
}

const ANALYTICS_CHANNEL = { email: 'email', 'in-app': 'in_app', sms: 'sms' } as const;

function trackReminderSent(
  parsed: ParsedReminderRow,
  recipientUserId: string,
  contextType: string
): void {
  for (const channel of MEETING_REMINDER_OFFSETS[parsed.offset].channels) {
    trackServer(MEETING_SERVER_EVENTS.MEETING_REMINDER_SENT, {
      meeting_id: parsed.meetingId,
      offset: parsed.offset,
      channel: ANALYTICS_CHANNEL[channel],
      audience: parsed.audience,
      context_type: contextType,
      distinct_id: recipientUserId,
    });
  }
}

async function decideReminder(row: Parameters<ScheduledRecheck>[0]): Promise<RecheckResult> {
  const parsed = parseReminderRow(row);
  if (parsed === null) {
    return skip('malformed_payload');
  }
  const meeting = await meetingsRepository.findById(parsed.meetingId);
  if (meeting === undefined) {
    return skip('meeting_missing');
  }
  const stateSkip = meetingStateSkip(meeting, parsed) ?? (await liveStateSkip(parsed, row.id));
  if (stateSkip !== null) {
    return skip(stateSkip);
  }

  const resolved = await resolveOwner(parsed.meetingId);
  if (resolved === null) {
    return skip('owner_unresolved');
  }
  const { primary, owner } = resolved;
  if (owner.companyId !== parsed.companyId || owner.expertProfileId !== parsed.expertProfileId) {
    return skip('owner_mismatch');
  }

  const recipient = await resolveMeetingSingleRecipient(parsed.audience, {
    meetingId: parsed.meetingId,
    companyId: parsed.companyId,
    expertProfileId: parsed.expertProfileId,
  });
  if (!recipient.ok) {
    return skip(recipient.reason);
  }
  if (MEETING_REMINDER_OFFSETS[parsed.offset].channels.some((channel) => channel === 'sms')) {
    const ineligible = await smsIneligibilityHoursOpen(parsed.audience, recipient.userId);
    if (ineligible !== null) {
      return skip(ineligible);
    }
  }

  const [counterpartyName, reschedulePath] = await Promise.all([
    counterpartyNameFor(parsed.audience, parsed, owner),
    resolveMeetingPagePath(primary, true),
  ]);
  // ⚠ ONE EMIT PER PROMISE: a send that dies after the claim is re-claimed and runs this guard
  // again, so only the first attempt reports.
  if (row.attempts <= 1) {
    trackReminderSent(parsed, recipient.userId, primary.contextType);
  }
  const payload: MeetingReminderPayload = {
    correlationId: parsed.correlationId,
    meetingId: parsed.meetingId,
    scheduledStartIso: parsed.scheduledStartIso,
    offset: parsed.offset,
    companyId: parsed.companyId,
    expertProfileId: parsed.expertProfileId,
    recipientUserId: recipient.userId,
    recipientTimeZone: recipient.timeZone,
    counterpartyName,
    callLabel: callLabelFor(primary.contextType),
    contextType: primary.contextType,
    durationMinutes: durationMinutesOf(meeting),
    joinPath: memberCallPath(parsed.meetingId),
    reschedulePath,
  };
  return { publish: true, payload: { ...payload } };
}

/**
 * THE PRE-CALL REMINDER GUARD. Publishes only if the meeting is still booked at the same start, was
 * not a Call now, its case is open, and the single recipient still exists (and, for the text, is
 * reachable by SMS now). Every skip is a normal outcome.
 *
 * ⚠ REPOSITORY THROWS PROPAGATE: the dispatch tick leaves the row `claimed` and retries it after
 * the claim TTL, so a transient DB failure never consumes the promise.
 */
export const meetingReminderRecheck: ScheduledRecheck = async (row) => {
  const decision = await decideReminder(row);
  const meetingId = meetingIdFrom(row.payload);
  if (decision.publish) {
    log.info({ meetingId, event: row.event }, 'Meeting reminder publishing');
  } else {
    log.info({ meetingId, event: row.event, reason: decision.reason }, 'Meeting reminder skipped');
  }
  return decision;
};
