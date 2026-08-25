import type { CreateEventInput } from '@apiroc/unified-calendar-api-node-sdk';
import { meetingCalendarEventsRepository, type MeetingCalendarEvent } from '@balo/db';
import { getApirocClient, callApiroc } from '../../lib/apiroc/index.js';

export interface WriteConsultationEventInput {
  readonly meetingId: string;
  readonly connectionId: string;
  readonly endUserAccountId: string;
  /** The calendar written to — becomes `meeting_calendar_events.calendar_id`, the value
   *  `delete-consultation-event.ts` reads back later (never the current `target_calendar_id`,
   *  which the expert may change afterwards). */
  readonly calendarId: string;
  readonly baloBookingId: string;
  readonly event: CreateEventInput;
}

/**
 * BAL-396 §5/§10.6 — one `events.create`, then record the VENDOR-RETURNED id. **LIVE since
 * BAL-400**, and reached by every bookable context since BAL-433 Slice 1.
 *
 * ⚠⚠ THE VENDOR-RETURNED ID, NEVER A DERIVED ONE (apiroc skill §M1). Microsoft answers HTTP
 * 200 to a caller-supplied `id` and silently substitutes a Graph id — a success response that
 * quietly did something else. `event-mapper.ts` never sets `id` for exactly this reason, but
 * IF a caller ever supplies one anyway, this asserts the vendor honoured it and throws on a
 * mismatch rather than silently recording the wrong id.
 */
export async function writeConsultationEvent(
  input: WriteConsultationEventInput
): Promise<MeetingCalendarEvent> {
  const client = getApirocClient();
  const created = await callApiroc('events.create', () =>
    client.events.create(input.endUserAccountId, input.calendarId, input.event)
  );

  const requestedId = input.event.id;
  if (requestedId !== undefined && created.id !== requestedId) {
    throw new Error(
      `Apiroc events.create returned a different event id than requested ` +
        `(requested=${requestedId}, returned=${created.id}) — apiroc skill §M1: a vendor ` +
        `silently substituted a different id instead of honouring the caller-supplied one.`
    );
  }

  return meetingCalendarEventsRepository.recordProviderEvent({
    meetingId: input.meetingId,
    /**
     * ⚠ STRUCTURAL, NOT A PARAMETER WAITING TO BE THREADED. Every provider event THIS writer
     * produces is the expert's: `endUserAccountId` comes off a `calendar_connections` row,
     * and that table is keyed on `expert_profile_id`. There is no client-side connection
     * model anywhere in the repo, so no writer produces a client-party `provider_event` row
     * today (BAL-475 delivers the client party by ICS). ⚠ That is a property of the writers,
     * not a constraint — the column and the repository both accept either party.
     */
    party: 'expert',
    connectionId: input.connectionId,
    calendarId: input.calendarId,
    vendorEventId: created.id,
    baloBookingId: input.baloBookingId,
  });
}
