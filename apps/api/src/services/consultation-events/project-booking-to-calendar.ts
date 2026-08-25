import {
  calendarRepository,
  meetingCalendarEventsRepository,
  type CalendarConnection,
  type CalendarCredentialStatus,
} from '@balo/db';
import type { FastifyBaseLogger } from 'fastify';
import { buildConsultationEvent } from './event-mapper.js';
import { writeConsultationEvent } from './write-consultation-event.js';

/**
 * BAL-400 (D2), widened by BAL-433 Slice 1 — the EXPERT-side calendar entry for one booking.
 * ADR-1044 §4/§5: calendars are PROJECTIONS; Balo is the system of record. This function NEVER
 * throws and NEVER fails the booking (D2c).
 *
 * ⚠ AN EXPERT WITH NO WRITABLE CALENDAR IS NO LONGER SILENCE. Before BAL-433 that case was a
 * `log.info` and a return; it is now a durable `delivery_mode='ics'` row (ADR-1044 amendment
 * 2026-08-25, Ruling 1) so the delivery slice has a fact to work from instead of re-deriving
 * the condition off `calendar_connections`. **NOTHING IS BUILT AND NOTHING IS SENT HERE.**
 *
 * ⚠ THIS IS THE EXPERT SIDE ONLY (D2a). `calendar_connections` is keyed on
 * `expert_profile_id` and no client-side connection model exists anywhere in the repo, so
 * there is no vendor path to a client's calendar. The CLIENT-party row is BAL-475's.
 *
 * ⚠ IDEMPOTENCY IS BALO'S OWN `(meeting_id, party)` — the partial unique behind
 * `recordProviderEvent` / `recordIcsDelivery` (`repositories/meeting-calendar-events.ts`). NOT
 * a caller-supplied event id: Microsoft silently substitutes one (apiroc skill §M1), so a
 * derived-id design double-books on every Microsoft retry while passing every Google test.
 */

/**
 * What ONE party's calendar entry actually became.
 *
 * ⚠ REPORTED FOR ANALYTICS, NEVER BRANCHED ON. Every value — `'failed'` included — leaves
 * the committed booking standing; nothing downstream may treat one of them as an error.
 *
 * ⚠ DECLARED HERE RATHER THAN IN `booking-calendar-projection.ts` (which the plan sketched)
 * purely to keep the import graph acyclic: that module imports this one.
 */
export type ExpertCalendarDelivery = 'provider_event' | 'ics' | 'skipped' | 'failed';

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
 * (flagged in the plan for a product call). The partial unique on `(meeting_id, party)`
 * structurally guarantees exactly one live entry per party regardless of which connection is
 * chosen.
 */
function pickWriteTarget(
  connections: readonly CalendarConnection[]
): (CalendarConnection & { targetCalendarId: string }) | undefined {
  return connections.find(isWritable);
}

export async function projectBookingToExpertCalendar(
  input: ProjectBookingToCalendarInput,
  log: FastifyBaseLogger
): Promise<ExpertCalendarDelivery> {
  try {
    const connections = await calendarRepository.listConnectionsByExpertProfileId(
      input.expertProfileId
    );
    const target = pickWriteTarget(connections);
    if (target === undefined) {
      /**
       * ADR-1044 amendment 2026-08-25, RULING 1 — no writable provider connection (none
       * connected, a non-`ACTIVE` credential, no target calendar, or an iCloud expert — who
       * reaches here as NO CONNECTION ROW AT ALL, never as a rejected write) means this party
       * gets a Balo-organizer ICS INSTEAD of a provider write. NEVER BOTH — and "never both"
       * is the partial unique on `(meeting_id, party)`, not this branch.
       *
       * ⚠ THERE IS NO PROVIDER CHECK AT THIS WRITE PATH AND THERE NEVER WAS. Do not add one,
       * and do not "restore" one: `isWritable` is exactly two conditions.
       *
       * ⚠ SLICE 1 RECORDS THE CONDITION AND SENDS NOTHING. BAL-475 builds and delivers the
       * ICS; BAL-476 owns cancellation. Do not add a send here.
       *
       * ⚠ THIS IS INSIDE THE `try` ON PURPOSE — a database blip on the fallback row degrades
       * to `'failed'` plus an error log, and the booking still stands.
       */
      await meetingCalendarEventsRepository.recordIcsDelivery({
        meetingId: input.meetingId,
        party: 'expert',
      });
      // ⚠ NO PROVIDER NAME, NO ADDRESS, NO CALENDAR ID. The connection COUNT is enough to
      // tell "never connected" from "connected but unusable".
      log.info(
        {
          meetingId: input.meetingId,
          expertProfileId: input.expertProfileId,
          connectionCount: connections.length,
        },
        'No writable calendar connection — recorded the expert-party ICS fallback (BAL-475 delivers)'
      );
      return 'ics';
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
    return 'provider_event';
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
    return 'failed';
  }
}
