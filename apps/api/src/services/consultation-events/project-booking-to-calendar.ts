import {
  calendarRepository,
  type CalendarConnection,
  type CalendarCredentialStatus,
} from '@balo/db';
import type { FastifyBaseLogger } from 'fastify';
import { buildConsultationEvent } from './event-mapper.js';
import { writeConsultationEvent } from './write-consultation-event.js';

/**
 * BAL-400 (D2) — write the EXPERT-side consultation event. ADR-1044 §4/§5: calendars are
 * PROJECTIONS; Balo is the system of record. This function NEVER throws and NEVER fails the
 * booking (D2c). An expert with no connection, a non-`ACTIVE` credential, or no target
 * calendar is a NORMAL case: log at info, return.
 *
 * ⚠ THIS IS THE EXPERT SIDE ONLY (D2a). No client-side ICS exists anywhere in the repo and
 * the client half is a separate ticket (BAL-433). Nothing here may tell the client their
 * calendar changed.
 *
 * ⚠ IDEMPOTENCY IS BALO'S OWN `meeting_id` — `meetingCalendarEventsRepository.record`'s
 * partial unique (`repositories/meeting-calendar-events.ts`). NOT a caller-supplied event id:
 * Microsoft silently substitutes one (apiroc skill §M1), so a derived-id design double-books
 * on every Microsoft retry while passing every Google test.
 */
export interface ProjectBookingToCalendarInput {
  readonly meetingId: string;
  readonly expertProfileId: string;
  /** ADR-1044 §4: the expert's event title names the client COMPANY. */
  readonly clientCompanyName: string;
  /**
   * The SUBJECT line rendered above the join URL. Named for BAL-400's only caller; since
   * BAL-283 it also carries a `request_interaction` booking's project-request title, which is
   * why {@link DEFAULT_EVENT_LABEL} and not this field decides the headline noun.
   */
  readonly caseTitle: string;
  /**
   * BAL-283 — the headline NOUN, so a context that is not a case does not announce itself as a
   * "Consultation" on the expert's calendar. OPTIONAL, defaulting to {@link DEFAULT_EVENT_LABEL}
   * — which is exactly BAL-400's shipped literal, so the `case` path is byte-identical and every
   * pre-BAL-283 caller keeps its title unchanged.
   *
   * ⚠ IT IS A LABEL, NOT A TITLE. The caller passes a fixed noun (`'Intro call'`); it is never
   * user input, so it needs no escaping and cannot widen what a booking can write here.
   */
  readonly eventLabel?: string;
  readonly startAt: Date;
  readonly endAt: Date;
  /** `${WEB_BASE_URL}/join/m/${meetingId}` — NEVER `meetings.join_url`. */
  readonly joinUrl: string;
}

/** BAL-400's shipped headline noun — the default, so omitting `eventLabel` changes nothing. */
const DEFAULT_EVENT_LABEL = 'Consultation';

const READABLE_STATUS: CalendarCredentialStatus = 'ACTIVE';

/**
 * A connection this projection may write to: `ACTIVE` and it has a chosen target calendar.
 * The repository deliberately does not filter status (mirrors `vendor-busy.ts`'s
 * `isUnreadable` guard) — this is the caller's obligation.
 */
function isWritable(
  connection: CalendarConnection
): connection is CalendarConnection & { targetCalendarId: string } {
  return connection.credentialStatus === READABLE_STATUS && connection.targetCalendarId !== null;
}

/**
 * Pick the connection to write the consultation event to, when the expert has more than one
 * live provider connected. `calendarRepository.listConnectionsByExpertProfileId` already
 * orders `OLDEST_LIVE_FIRST` (`createdAt` then `id`), so the first writable row IS the
 * oldest-live-first pick — deterministic, though which calendar "should" win when an expert
 * has both a Google and a Microsoft connection is settled nowhere in the repo or the ADRs
 * (flagged in the plan for a product call). The partial unique on `meeting_id` structurally
 * guarantees exactly one event per meeting regardless of which connection is chosen.
 */
function pickWriteTarget(
  connections: readonly CalendarConnection[]
): (CalendarConnection & { targetCalendarId: string }) | undefined {
  return connections.find(isWritable);
}

export async function projectBookingToExpertCalendar(
  input: ProjectBookingToCalendarInput,
  log: FastifyBaseLogger
): Promise<void> {
  try {
    const connections = await calendarRepository.listConnectionsByExpertProfileId(
      input.expertProfileId
    );
    const target = pickWriteTarget(connections);
    if (target === undefined) {
      log.info(
        { meetingId: input.meetingId, expertProfileId: input.expertProfileId },
        'No writable calendar connection for this expert — skipping consultation-event projection'
      );
      return;
    }

    const event = buildConsultationEvent({
      title: `${input.eventLabel ?? DEFAULT_EVENT_LABEL} with ${input.clientCompanyName}`,
      caseTitle: input.caseTitle,
      startAt: input.startAt,
      endAt: input.endAt,
      baloBookingId: input.meetingId,
      joinUrl: input.joinUrl,
    });

    await writeConsultationEvent({
      meetingId: input.meetingId,
      connectionId: target.id,
      endUserAccountId: target.endUserAccountId,
      calendarId: target.targetCalendarId,
      baloBookingId: input.meetingId,
      event,
    });
  } catch (error) {
    // ⚠ THE BOOKING STANDS (D2c) — this is a best-effort projection, never the booking of
    // record. Log and return; never rethrow, never surface a calendar error to the client.
    log.error(
      {
        meetingId: input.meetingId,
        expertProfileId: input.expertProfileId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'Expert calendar projection failed'
    );
  }
}
