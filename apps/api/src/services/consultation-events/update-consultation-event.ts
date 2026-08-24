import { getApirocClient, callApiroc } from '../../lib/apiroc/index.js';

export interface UpdateConsultationEventInput {
  readonly meetingId: string;
  /**
   * Caller-supplied, exactly as `deleteConsultationEvent` does — `calendarRepository` exposes
   * no "get connection by id" read.
   */
  readonly endUserAccountId: string;
  /** The STORED calendar, never the expert's current `target_calendar_id`. */
  readonly calendarId: string;
  /** The VENDOR-RETURNED id off `meeting_calendar_events`. */
  readonly vendorEventId: string;
  readonly startAt: Date;
  readonly endAt: Date;
}

/**
 * BAL-409 — the net-new Apiroc amend: one `events.update` (a `PUT`), moving ONLY `start`/`end`.
 * There was no `update-consultation-event.ts` before this ticket — `services/consultation-
 * events/` shipped exactly `event-mapper.ts`, `write-consultation-event.ts`,
 * `delete-consultation-event.ts`, `reconcile-by-tag.ts`. BAL-393 resolved the spike question
 * YES for both tag read-back and in-place `PUT`, on both providers, so this does NOT degrade to
 * delete-and-recreate.
 *
 * Rules, all from the apiroc skill (`references/webhooks-and-events.md` B3 / SKILL.md M3):
 *
 * ⚠ A PARTIAL `PUT`. Send only `start`/`end` — never `id`, never `privateExtendedProperties`,
 * never attendees. `UpdateEventInput = Partial<Omit<CreateEventInput,'id'|'generateMeetingUrlProvider'>>`
 * [stat], so an omitted field is left ALONE, not cleared.
 *
 * ⚠ NEVER RE-SEND THE TAG. A partial `PUT` that omits `privateExtendedProperties` leaves it
 * alone; the tag SURVIVES the PUT — directly observed on Google, and on Microsoft the `{}`
 * response is not evidence of loss because the same event still matches a `metadataFilters`
 * query (§M3 / B3).
 *
 * ⚠⚠ NEVER READ THE RESPONSE TO VERIFY THE WRITE. No id assertion, no tag read, no
 * `dateTime`/timezone/description string compare — Google rewrites offsets, Microsoft
 * flattens newlines, both diverge on write-response echoes in ways a caller cannot safely
 * infer meaning from. "Verify by querying, never by reading a tag off a write response"
 * (§M3) — Slice A performs NO verification read at all; that belongs to the drift/
 * reconciliation ticket (Slice B).
 *
 * ⚠ NO `id` IS EVER SENT (§M1) — Microsoft silently substitutes its own id on a caller-supplied
 * one, so a derived id is not a portable idempotency lever. This function never constructs one.
 *
 * ⚠ NO ATTENDEES, EVER — ADR-1044 §4 HARD CONSTRAINT: an attendee on a provider-written event
 * makes the PROVIDER email from the expert's own mailbox. Never set here, matching the mapper.
 *
 * ⚠ NO PROVIDER LITERAL anywhere in this file (Scan B scans this directory tree-wide).
 *
 * ONE `callApiroc` call — its contract is exactly one fallible SDK call, never a `Promise.all`
 * inside one. Throws a normalized `ApirocError`; the retry/converge branching belongs to the
 * caller (the `meeting-calendar-amend` BullMQ job), not to this function.
 */
export async function updateConsultationEvent(input: UpdateConsultationEventInput): Promise<void> {
  const client = getApirocClient();
  await callApiroc('events.update', () =>
    client.events.update(input.endUserAccountId, input.calendarId, input.vendorEventId, {
      start: { dateTime: input.startAt.toISOString(), timeZone: 'UTC' },
      end: { dateTime: input.endAt.toISOString(), timeZone: 'UTC' },
    })
  );
}
