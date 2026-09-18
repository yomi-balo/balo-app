import * as Sentry from '@sentry/node';
import {
  meetingCalendarEventsRepository,
  meetingContextsRepository,
  type MeetingCalendarDeliveryMode,
  type MeetingCalendarEvent,
  type MeetingCalendarSequenceBump,
} from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { BOOKABLE_CONTEXT_TYPES, selectPrimaryMeetingContext } from '@balo/shared/meetings';
import type { FastifyBaseLogger } from 'fastify';
import { notificationEvents } from '../../notifications/index.js';
import {
  CALENDAR_INVITE_TRANSITION_METHOD,
  isCalendarInviteParty,
  type CalendarInviteMethod,
  type CalendarInviteParty,
  type CalendarInviteRecipient,
  type CalendarInviteTransition,
} from '../../notifications/calendar-invite-spec.js';
import type { CalendarProjectedContextType } from '../consultation-events/calendar-context-registry.js';
import { calendarInviteCorrelationId } from './correlation-id.js';
import { calendarInviteLogFields } from './log-fields.js';
import { resolveCalendarInviteRecipients } from './resolve-calendar-invite-recipients.js';

/**
 * BAL-475 / BAL-476 — publishes ONE `meeting.calendar_invite` per (row × recipient). Post-commit,
 * so EVERY FUNCTION HERE NEVER THROWS: the transition they follow already committed.
 *
 * ⚠ BAL-476 — NOTHING IN THIS FILE WRITES A METHOD LITERAL. Every caller reads it from
 * `CALENDAR_INVITE_TRANSITION_METHOD`, the one definition of "which transitions issue and which
 * withdraw", so a new transition cannot be a silent REQUEST.
 *
 * F6 (fix round 1, R5/S9/R23) — EVERY DB READ IN THIS FILE IS ITS OWN try/catch, not just the
 * publish call. A transient read failure (the initial `listLiveByMeeting`, one row's
 * `resolveCalendarInviteRecipients`, or the reschedule context read) logs `error` + `stack`,
 * calls `Sentry.captureException`, and either `continue`s to the next row (mid-loop) or
 * `return`s (the top-level read) — it never rejects the caller. That is what makes the three
 * callers' own catch blocks a genuine "this is a contract violation" rather than the routine DB
 * blip this file used to let through as an unhandled rejection.
 */

function isBookableContextType(value: string): value is (typeof BOOKABLE_CONTEXT_TYPES)[number] {
  return (BOOKABLE_CONTEXT_TYPES as readonly string[]).includes(value);
}

/** F5 (fix round 1) — narrow a wider context-type label to the closed bookable set a calendar
 *  invite spec may name; `null` for anything outside it (never a cast). */
function toBookableContextType(value: string): (typeof BOOKABLE_CONTEXT_TYPES)[number] | null {
  return isBookableContextType(value) ? value : null;
}

export type CalendarInviteLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;

const defaultLog = createLogger('calendar-invite-publisher');

async function publishOne(input: {
  readonly meetingId: string;
  readonly party: CalendarInviteParty;
  readonly calendarEventId: string;
  readonly transition: CalendarInviteTransition;
  /** ⚠ Always `CALENDAR_INVITE_TRANSITION_METHOD[transition]` — never a literal at the call
   *  site. `readCalendarInviteSpec` rejects an incoherent pair outright. */
  readonly method: CalendarInviteMethod;
  readonly recipient: CalendarInviteRecipient;
  readonly correlationId: string;
  readonly contextType: (typeof BOOKABLE_CONTEXT_TYPES)[number] | null;
  readonly sequence: number | null;
  readonly log: CalendarInviteLogger;
}): Promise<void> {
  const spec = {
    meetingId: input.meetingId,
    party: input.party,
    calendarEventId: input.calendarEventId,
    method: input.method,
    transition: input.transition,
    recipient: input.recipient,
    contextType: input.contextType,
  };
  const fields = calendarInviteLogFields({
    spec,
    contextType: input.contextType,
    sequence: input.sequence,
  });

  try {
    await notificationEvents.publish('meeting.calendar_invite', {
      correlationId: input.correlationId,
      calendarInvite: spec,
    });
    input.log.info({ ...fields, correlationId: input.correlationId }, 'Calendar invite enqueued');
  } catch (error) {
    input.log.error(
      {
        ...fields,
        correlationId: input.correlationId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'Calendar invite enqueue failed'
    );
    Sentry.captureException(error, { extra: { ...fields, correlationId: input.correlationId } });
  }
}

/** F6 (fix round 1) — one row's read failed; log + Sentry, never rethrow. */
function logReadFailure(input: {
  readonly log: CalendarInviteLogger;
  readonly meetingId: string;
  readonly party: CalendarInviteParty | null;
  readonly step: string;
  readonly error: unknown;
}): void {
  const fields = {
    meetingId: input.meetingId,
    party: input.party,
    step: input.step,
    error: input.error instanceof Error ? input.error.message : String(input.error),
    stack: input.error instanceof Error ? input.error.stack : undefined,
  };
  input.log.error(fields, 'Calendar invite publisher read failed');
  Sentry.captureException(input.error, { extra: fields });
}

function logSkip(input: {
  readonly log: CalendarInviteLogger;
  readonly meetingId: string;
  readonly party: CalendarInviteParty | null;
  readonly reason: 'no_calendar_row' | 'no_member_recipient' | 'provider_event_party';
}): void {
  input.log.info(
    { meetingId: input.meetingId, party: input.party, reason: input.reason },
    'Calendar invite not enqueued'
  );
}

/**
 * One row's recipient list, with the read's own try/catch and the empty-list skip.
 *
 * ⚠ `null` MEANS "SKIP THIS ROW" — the caller `continue`s. Extracted (BAL-476) because the
 * booking, reschedule and cancellation fan-outs need byte-identical behaviour here and three
 * copies of it is how they drift apart (and how the duplication gate fails).
 */
async function resolveRowRecipients(input: {
  readonly meetingId: string;
  readonly party: CalendarInviteParty;
  readonly deliveryMode: MeetingCalendarDeliveryMode;
  readonly expertProfileId: string | null;
  readonly log: CalendarInviteLogger;
}): Promise<CalendarInviteRecipient[] | null> {
  const { meetingId, party, deliveryMode, expertProfileId, log } = input;
  let recipients: CalendarInviteRecipient[];
  try {
    recipients = await resolveCalendarInviteRecipients({
      meetingId,
      party,
      deliveryMode,
      expertProfileId,
    });
  } catch (error) {
    logReadFailure({ log, meetingId, party, step: 'resolveCalendarInviteRecipients', error });
    return null;
  }
  if (recipients.length === 0) {
    logSkip({
      log,
      meetingId,
      party,
      reason: deliveryMode === 'provider_event' ? 'provider_event_party' : 'no_member_recipient',
    });
    return null;
  }
  return recipients;
}

/**
 * ONE primary-context read, for LOGS ONLY — never re-derives what should be sent. F6: its own
 * try/catch; F5 additionally narrows the result to the closed bookable set the spec's
 * `contextType` field accepts (a `retainer_checkin` primary — holder-bearing but not bookable —
 * is unreachable for a meeting that has a calendar row, but the TYPE is wider, so this degrades
 * to `null` rather than asserting).
 *
 * ⚠ SHARED BY THE RESCHEDULE AND CANCELLATION FAN-OUTS (BAL-476), and that is exactly why
 * neither of their callers has to supply a `contextType`: the BAL-540 close cascade has no
 * context in hand and still gets a correctly-labelled log line.
 */
async function resolveContextTypeForLogs(
  meetingId: string,
  log: CalendarInviteLogger
): Promise<(typeof BOOKABLE_CONTEXT_TYPES)[number] | null> {
  try {
    const contexts = await meetingContextsRepository.listByMeeting(meetingId);
    const primary = selectPrimaryMeetingContext(contexts);
    return primary.ok ? toBookableContextType(primary.context.contextType) : null;
  } catch (error) {
    logReadFailure({
      log,
      meetingId,
      party: null,
      step: 'listByMeeting (contextType, logs only)',
      error,
    });
    return null;
  }
}

/**
 * The booking fan-out: every LIVE calendar row of the meeting, fanned out to its resolved
 * recipients, each at that row's SEQUENCE (0 at booking).
 */
export async function publishBookingCalendarInvites(
  input: {
    readonly meetingId: string;
    readonly contextType: CalendarProjectedContextType;
    readonly expertProfileId: string | null;
  },
  log: CalendarInviteLogger = defaultLog
): Promise<void> {
  let rows: Awaited<ReturnType<typeof meetingCalendarEventsRepository.listLiveByMeeting>>;
  try {
    rows = await meetingCalendarEventsRepository.listLiveByMeeting(input.meetingId);
  } catch (error) {
    logReadFailure({
      log,
      meetingId: input.meetingId,
      party: null,
      step: 'listLiveByMeeting',
      error,
    });
    return;
  }
  if (rows.length === 0) {
    logSkip({ log, meetingId: input.meetingId, party: null, reason: 'no_calendar_row' });
    return;
  }

  for (const row of rows) {
    if (!isCalendarInviteParty(row.party)) {
      // Unreachable under `meeting_calendar_event_party_two_sided` — a database that disagrees
      // with its own CHECK must not be published from.
      log.error(
        { meetingId: input.meetingId, calendarEventId: row.id, party: row.party },
        'meeting_calendar_events row holds a party the two-sided CHECK forbids — skipping'
      );
      continue;
    }
    const party = row.party;

    const recipients = await resolveRowRecipients({
      meetingId: input.meetingId,
      party,
      deliveryMode: row.deliveryMode,
      expertProfileId: input.expertProfileId,
      log,
    });
    if (recipients === null) continue;

    for (const recipient of recipients) {
      await publishOne({
        meetingId: input.meetingId,
        party,
        calendarEventId: row.id,
        transition: 'booked',
        method: CALENDAR_INVITE_TRANSITION_METHOD.booked,
        recipient,
        correlationId: calendarInviteCorrelationId({
          transition: 'booked',
          calendarEventId: row.id,
          sequence: row.sequence,
          party,
          recipient,
        }),
        contextType: input.contextType,
        sequence: row.sequence,
        log,
      });
    }
  }
}

/**
 * The reschedule fan-out: uses the ALREADY-BUMPED rows the caller passed in — this function
 * never reads `sequence` itself, which is what makes "no double increment" structural rather
 * than a convention (a write call here would be a TypeError against the mocked repository in
 * unit tests, since only `listLiveByMeeting`/`findLiveById` are exposed to it).
 */
export async function publishRescheduleCalendarInvites(
  input: {
    readonly meetingId: string;
    readonly rescheduleAuditId: string;
    readonly expertProfileId: string | null;
    readonly calendarEvents: readonly MeetingCalendarSequenceBump[];
  },
  log: CalendarInviteLogger = defaultLog
): Promise<void> {
  if (input.calendarEvents.length === 0) {
    logSkip({ log, meetingId: input.meetingId, party: null, reason: 'no_calendar_row' });
    return;
  }

  const contextType = await resolveContextTypeForLogs(input.meetingId, log);

  for (const row of input.calendarEvents) {
    const recipients = await resolveRowRecipients({
      meetingId: input.meetingId,
      party: row.party,
      deliveryMode: row.deliveryMode,
      expertProfileId: input.expertProfileId,
      log,
    });
    if (recipients === null) continue;

    for (const recipient of recipients) {
      await publishOne({
        meetingId: input.meetingId,
        party: row.party,
        calendarEventId: row.id,
        transition: 'rescheduled',
        method: CALENDAR_INVITE_TRANSITION_METHOD.rescheduled,
        recipient,
        correlationId: calendarInviteCorrelationId({
          transition: 'rescheduled',
          rescheduleAuditId: input.rescheduleAuditId,
          party: row.party,
          recipient,
        }),
        contextType,
        sequence: row.sequence,
        log,
      });
    }
  }
}

/**
 * The guest-add fan-out: ONE ICS to each NEWLY added guest, at the side's CURRENT sequence
 * (U4) — no bump, no re-send to anyone else.
 */
export async function publishGuestAddedCalendarInvites(
  input: {
    readonly meetingId: string;
    readonly party: CalendarInviteParty;
    readonly guestIds: readonly string[];
    readonly contextType: string;
  },
  log: CalendarInviteLogger = defaultLog
): Promise<void> {
  let rows: Awaited<ReturnType<typeof meetingCalendarEventsRepository.listLiveByMeeting>>;
  try {
    rows = await meetingCalendarEventsRepository.listLiveByMeeting(input.meetingId);
  } catch (error) {
    logReadFailure({
      log,
      meetingId: input.meetingId,
      party: input.party,
      step: 'listLiveByMeeting',
      error,
    });
    return;
  }
  const row = rows.find((candidate) => candidate.party === input.party);
  if (row === undefined) {
    logSkip({ log, meetingId: input.meetingId, party: input.party, reason: 'no_calendar_row' });
    return;
  }

  const contextType = toBookableContextType(input.contextType);
  for (const guestId of input.guestIds) {
    const recipient: CalendarInviteRecipient = { kind: 'guest', guestId };
    await publishOne({
      meetingId: input.meetingId,
      party: input.party,
      calendarEventId: row.id,
      transition: 'guest_added',
      method: CALENDAR_INVITE_TRANSITION_METHOD.guest_added,
      recipient,
      correlationId: calendarInviteCorrelationId({ transition: 'guest_added', guestId }),
      contextType,
      sequence: row.sequence,
      log,
    });
  }
}

/**
 * BAL-476 — THE CANCELLATION FAN-OUT: one `METHOD:CANCEL` to every recipient of every row the
 * CALLER read, at each row's CURRENT `sequence` (no bump — `sequence` keeps its single writer,
 * `_shared/calendar-sequence.ts`, which is what makes "no double increment on retry" structural).
 *
 * NEVER THROWS. The rows are the caller's read (see `withdrawMeetingCalendarProjection`) so the
 * publish and the retire act on ONE SNAPSHOT — and so the publish can run BEFORE the retire.
 *
 * ⚠ AN EXPERT-PARTY `provider_event` ROW STILL FANS OUT, to that side's admitted GUESTS:
 * `resolveCalendarInviteRecipients` includes the expert MEMBER only for an `ics` row but includes
 * that side's guests whatever the mode. That is precisely why the delivery path's calendar-row
 * gate had to become retired-tolerant rather than the vendor delete being reordered.
 */
export async function publishCancellationCalendarWithdrawals(
  input: {
    readonly meetingId: string;
    /** The `meeting.cancelled` audit row id — per WRITE, never per state. */
    readonly cancelAuditId: string;
    readonly expertProfileId: string | null;
    readonly calendarEvents: readonly MeetingCalendarEvent[];
  },
  log: CalendarInviteLogger = defaultLog
): Promise<void> {
  if (input.calendarEvents.length === 0) {
    logSkip({ log, meetingId: input.meetingId, party: null, reason: 'no_calendar_row' });
    return;
  }

  const contextType = await resolveContextTypeForLogs(input.meetingId, log);

  for (const row of input.calendarEvents) {
    if (!isCalendarInviteParty(row.party)) {
      // Unreachable under `meeting_calendar_event_party_two_sided` — a database that disagrees
      // with its own CHECK must not be published from.
      log.error(
        { meetingId: input.meetingId, calendarEventId: row.id, party: row.party },
        'meeting_calendar_events row holds a party the two-sided CHECK forbids — skipping'
      );
      continue;
    }
    const party = row.party;

    const recipients = await resolveRowRecipients({
      meetingId: input.meetingId,
      party,
      deliveryMode: row.deliveryMode,
      expertProfileId: input.expertProfileId,
      log,
    });
    if (recipients === null) continue;

    for (const recipient of recipients) {
      await publishOne({
        meetingId: input.meetingId,
        party,
        calendarEventId: row.id,
        transition: 'cancelled',
        method: CALENDAR_INVITE_TRANSITION_METHOD.cancelled,
        recipient,
        correlationId: calendarInviteCorrelationId({
          transition: 'cancelled',
          cancelAuditId: input.cancelAuditId,
          party,
          recipient,
        }),
        contextType,
        sequence: row.sequence,
        log,
      });
    }
  }
}

/**
 * BAL-476 (R2) — THE GUEST-REMOVAL WITHDRAWAL: ONE `METHOD:CANCEL` to the removed person, at the
 * side's CURRENT sequence.
 *
 * ⚠⚠ NOTHING IS SENT TO ANYONE ELSE AND NO SEQUENCE IS BUMPED. R2 departs from the inherited AC's
 * "SEQUENCE incremented" deliberately: `sequence` has exactly one writer, inside `updateSchedule`'s
 * transaction, and a second writer out here would forfeit the structural no-double-increment
 * property. It is RFC-legal — no ICS Balo issues lists any other person, so a per-recipient
 * withdrawal invalidates nobody else's copy — and BAL-475 made the same departure for guest-ADD.
 */
export async function publishGuestRemovedCalendarWithdrawal(
  input: {
    readonly meetingId: string;
    readonly party: CalendarInviteParty;
    readonly guestId: string;
    readonly contextType: string;
  },
  log: CalendarInviteLogger = defaultLog
): Promise<void> {
  let rows: Awaited<ReturnType<typeof meetingCalendarEventsRepository.listLiveByMeeting>>;
  try {
    rows = await meetingCalendarEventsRepository.listLiveByMeeting(input.meetingId);
  } catch (error) {
    logReadFailure({
      log,
      meetingId: input.meetingId,
      party: input.party,
      step: 'listLiveByMeeting',
      error,
    });
    return;
  }
  const row = rows.find((candidate) => candidate.party === input.party);
  if (row === undefined) {
    logSkip({ log, meetingId: input.meetingId, party: input.party, reason: 'no_calendar_row' });
    return;
  }

  await publishOne({
    meetingId: input.meetingId,
    party: input.party,
    calendarEventId: row.id,
    transition: 'guest_removed',
    method: CALENDAR_INVITE_TRANSITION_METHOD.guest_removed,
    recipient: { kind: 'guest', guestId: input.guestId },
    correlationId: calendarInviteCorrelationId({
      transition: 'guest_removed',
      guestId: input.guestId,
    }),
    contextType: toBookableContextType(input.contextType),
    sequence: row.sequence,
    log,
  });
}
