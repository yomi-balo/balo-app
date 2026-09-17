import ical, { ICalCalendarMethod, ICalEventStatus, ICalEventTransparency } from 'ical-generator';

/**
 * BAL-475 (U1) — THE PURE RFC 5545 BUILDER, and the ONE PINNED EXCEPTION to the
 * counterparty-address invariant (`invariants/no-counterparty-address-on-calendar-writes.test.ts`).
 * The invariant permits EXACTLY the two lines below — the recipient-self ATTENDEE and Balo's own
 * ORGANIZER — inside THIS function and nowhere else under `services/calendar-invites/` or
 * `services/consultation-events/`. Do not reformat them, do not move them out of
 * `buildCalendarInviteIcs`, and do not add a third address-bearing line anywhere in this file.
 *
 * ⚠ ONE ATTENDEE, BY SIGNATURE. `recipientAddress` is a `string`, never an array — the type
 * itself makes a fan-out to more than one attendee unrepresentable. No `CN` on the attendee (no
 * name reaches a parameter here). No CONTACT, no URL, no alarms, no `x()` custom properties, no
 * calendar `name` (ical-generator writes `NAME:`/`X-WR-CALNAME:` UNescaped, unlike SUMMARY).
 *
 * ⚠ ESCAPING IS THE LIBRARY'S, NEVER THIS MODULE'S. `escapeIcsText` (`@balo/shared/calendar`) is
 * the escaping ORACLE this file's tests pin against — never called here at runtime. Escaping
 * `summary`/`description` before handing them to `ical-generator` would double-escape them
 * (`Northwind, Inc.` would render `Northwind\, Inc.` in every client).
 *
 * ⚠ NO METHOD OTHER THAN REQUEST IN THIS TICKET — BAL-476 adds CANCEL.
 */

export const CALENDAR_INVITE_ORGANIZER_NAME = 'Balo';
export const CALENDAR_INVITE_PRODUCT_ID = {
  company: 'Balo',
  product: 'Calendar Invite',
  language: 'EN',
} as const;

export interface BuildCalendarInviteIcsInput {
  /** The RFC 5545 UID — `meeting_calendar_events.uid`. Stability is the CALLER's; this builder
   *  never invents one. */
  readonly uid: string;
  readonly sequence: number;
  readonly summary: string;
  readonly description: string;
  readonly location: string | undefined;
  readonly startAt: Date;
  readonly endAt: Date;
  /** DTSTAMP — an INJECTED clock, never `new Date()` read directly, so the builder is testable
   *  and its output is deterministic for a fixed input. */
  readonly stampAt: Date;
  /** Balo's no-reply mailbox (env-configured) — becomes ORGANIZER. */
  readonly organizerAddress: string;
  /** THE ONLY ATTENDEE — the person this message is delivered to. */
  readonly recipientAddress: string;
}

/**
 * Build one Balo-organised RFC 5545 VCALENDAR/VEVENT as a CRLF-terminated string.
 *
 * `ical-generator`'s own `toString()` omits the trailing CRLF that RFC 5545 §3.1 requires on
 * every content line, including the last — so this function appends it.
 */
export function buildCalendarInviteIcs(input: BuildCalendarInviteIcsInput): string {
  const calendar = ical({ prodId: CALENDAR_INVITE_PRODUCT_ID, method: ICalCalendarMethod.REQUEST });
  const event = calendar.createEvent({
    id: input.uid,
    sequence: input.sequence,
    stamp: input.stampAt,
    start: input.startAt,
    end: input.endAt,
    summary: input.summary,
    description: input.description,
    ...(input.location === undefined ? {} : { location: input.location }),
    status: ICalEventStatus.CONFIRMED,
    transparency: ICalEventTransparency.OPAQUE,
    organizer: { name: CALENDAR_INVITE_ORGANIZER_NAME, email: input.organizerAddress },
  });
  event.createAttendee({ email: input.recipientAddress, rsvp: false });

  return `${calendar.toString()}\r\n`;
}
