import * as Sentry from '@sentry/node';
import {
  meetingCalendarEventsRepository,
  meetingContextsRepository,
  type MeetingCalendarSequenceBump,
} from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { BOOKABLE_CONTEXT_TYPES, selectPrimaryMeetingContext } from '@balo/shared/meetings';
import type { FastifyBaseLogger } from 'fastify';
import { notificationEvents } from '../../notifications/index.js';
import {
  CALENDAR_INVITE_METHOD,
  isCalendarInviteParty,
  type CalendarInviteParty,
  type CalendarInviteRecipient,
  type CalendarInviteTransition,
} from '../../notifications/calendar-invite-spec.js';
import type { CalendarProjectedContextType } from '../consultation-events/calendar-context-registry.js';
import { calendarInviteCorrelationId } from './correlation-id.js';
import { calendarInviteLogFields } from './log-fields.js';
import { resolveCalendarInviteRecipients } from './resolve-calendar-invite-recipients.js';

/**
 * BAL-475 — publishes ONE `meeting.calendar_invite` per (row × recipient). Post-commit, so ALL
 * THREE FUNCTIONS HERE NEVER THROW: the transition they follow already committed.
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
    method: CALENDAR_INVITE_METHOD,
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

    let recipients: CalendarInviteRecipient[];
    try {
      recipients = await resolveCalendarInviteRecipients({
        meetingId: input.meetingId,
        party,
        deliveryMode: row.deliveryMode,
        expertProfileId: input.expertProfileId,
      });
    } catch (error) {
      logReadFailure({
        log,
        meetingId: input.meetingId,
        party,
        step: 'resolveCalendarInviteRecipients',
        error,
      });
      continue;
    }
    if (recipients.length === 0) {
      logSkip({
        log,
        meetingId: input.meetingId,
        party,
        reason:
          row.deliveryMode === 'provider_event' ? 'provider_event_party' : 'no_member_recipient',
      });
      continue;
    }

    for (const recipient of recipients) {
      await publishOne({
        meetingId: input.meetingId,
        party,
        calendarEventId: row.id,
        transition: 'booked',
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

  // ONE primary-context read, for LOGS ONLY — never re-derives what should be sent. F6: its
  // own try/catch already existed; F5 additionally narrows the result to the closed bookable
  // set the spec's `contextType` field accepts (a `retainer_checkin` primary — holder-bearing
  // but not bookable — is unreachable for a meeting that has a calendar row, but the TYPE is
  // wider, so this degrades to `null` rather than asserting).
  let contextType: (typeof BOOKABLE_CONTEXT_TYPES)[number] | null = null;
  try {
    const contexts = await meetingContextsRepository.listByMeeting(input.meetingId);
    const primary = selectPrimaryMeetingContext(contexts);
    contextType = primary.ok ? toBookableContextType(primary.context.contextType) : null;
  } catch (error) {
    logReadFailure({
      log,
      meetingId: input.meetingId,
      party: null,
      step: 'listByMeeting (contextType, logs only)',
      error,
    });
    contextType = null;
  }

  for (const row of input.calendarEvents) {
    let recipients: CalendarInviteRecipient[];
    try {
      recipients = await resolveCalendarInviteRecipients({
        meetingId: input.meetingId,
        party: row.party,
        deliveryMode: row.deliveryMode,
        expertProfileId: input.expertProfileId,
      });
    } catch (error) {
      logReadFailure({
        log,
        meetingId: input.meetingId,
        party: row.party,
        step: 'resolveCalendarInviteRecipients',
        error,
      });
      continue;
    }
    if (recipients.length === 0) {
      logSkip({
        log,
        meetingId: input.meetingId,
        party: row.party,
        reason:
          row.deliveryMode === 'provider_event' ? 'provider_event_party' : 'no_member_recipient',
      });
      continue;
    }

    for (const recipient of recipients) {
      await publishOne({
        meetingId: input.meetingId,
        party: row.party,
        calendarEventId: row.id,
        transition: 'rescheduled',
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
      recipient,
      correlationId: calendarInviteCorrelationId({ transition: 'guest_added', guestId }),
      contextType,
      sequence: row.sequence,
      log,
    });
  }
}
