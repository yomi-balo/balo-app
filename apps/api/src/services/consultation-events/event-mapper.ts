import type { CreateEventInput } from '@apiroc/unified-calendar-api-node-sdk';

/**
 * BAL-396 §5/§10.6 — the input Balo has in hand at booking time. Ships INERT: the booking flow
 * that calls it is BAL-400's (`services/meetings/meeting-availability.ts` is explicit that
 * booking-time side effects belong there, not here).
 */
export interface ConsultationEventInput {
  readonly title: string;
  readonly startAt: Date;
  readonly endAt: Date;
  /** Balo's own booking id — written to `privateExtendedProperties.baloBookingId`, and the
   *  value `reconcile-by-tag.ts` queries for later. Never re-derived from the event. */
  readonly baloBookingId: string;
  /** The Daily room the client/expert actually meet in — carried in BOTH `description` and
   *  `location` so it is visible regardless of which field a calendar client surfaces. */
  readonly joinUrl: string;
  /**
   * BAL-400 (D2) — OPTIONAL. When present, prefixes `description` above the join URL so the
   * expert's calendar names WHAT the consultation is about, not only where to join it.
   * Absent ⇒ `description` is exactly `joinUrl`, unchanged from BAL-396's shipped shape (every
   * caller before BAL-400 omits it).
   */
  readonly caseTitle?: string;
}

/**
 * Builds the vendor-agnostic `CreateEventInput` for a consultation. No provider branch
 * anywhere (apiroc skill provider-parity table is encoded as tolerant parsing elsewhere in
 * this directory, never here as a branch):
 *
 *  - `transparency: 'opaque'` — the event blocks time on the expert's calendar.
 *  - `privateExtendedProperties: { baloBookingId }` — write-and-query-only on Microsoft
 *    (§M3); never read back by this mapper or any caller.
 *  - NO `id` — a caller-supplied id is not a portable idempotency lever (§M1: Microsoft
 *    silently substitutes its own). Idempotency is Balo's own `meeting_id`, enforced by
 *    `meetingCalendarEventsRepository.record`'s partial unique, not by this event.
 *  - NO attendees — the client is deliberately NOT invited; comms stay in Balo.
 *  - NO `generateMeetingUrlProvider` — Daily is the venue; Balo never asks the vendor to
 *    generate its own meeting link (Microsoft has no `allowedOnlineMeetingProviders` at all;
 *    asserted here by absence, not by a provider check).
 *  - `start`/`end` as `{ dateTime: <ISO>, timeZone: 'UTC' }` — Balo's own timezone, never a
 *    calendar's (Microsoft calendars carry no `timeZone` at all — parity table).
 */
export function buildConsultationEvent(input: ConsultationEventInput): CreateEventInput {
  return {
    title: input.title,
    description:
      input.caseTitle === undefined ? input.joinUrl : `${input.caseTitle}\n\n${input.joinUrl}`,
    location: input.joinUrl,
    start: { dateTime: input.startAt.toISOString(), timeZone: 'UTC' },
    end: { dateTime: input.endAt.toISOString(), timeZone: 'UTC' },
    transparency: 'opaque',
    privateExtendedProperties: { baloBookingId: input.baloBookingId },
  };
}
