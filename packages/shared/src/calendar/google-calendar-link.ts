/**
 * Google Calendar's "create event" link (`action=TEMPLATE`). Opening it shows Google's own
 * pre-filled event form, so the call lands in the reader's calendar with one click regardless of
 * their "Add invitations to my calendar" setting — which can stop an emailed `.ics` invite from
 * being added on its own (e.g. "Only if the sender is known").
 *
 * The event it creates is the reader's own, unlinked from Balo's invite UID: a later reschedule
 * or cancellation `.ics` does not update it. Callers carry only what the `.ics` carries — never a
 * counterparty address (ADR-1044 §4).
 */
export interface GoogleCalendarLinkInput {
  readonly title: string;
  readonly start: Date;
  readonly end: Date;
  readonly details?: string;
  readonly location?: string;
}

const GOOGLE_CALENDAR_TEMPLATE_URL = 'https://calendar.google.com/calendar/render';

/** `2026-11-17T22:00:00.000Z` → `20261117T220000Z` (the UTC basic format Google expects). */
function toGoogleUtcStamp(date: Date): string {
  const [stamp] = date.toISOString().replace(/[-:]/g, '').split('.');
  return `${stamp ?? ''}Z`;
}

export function buildGoogleCalendarLink(input: Readonly<GoogleCalendarLinkInput>): string {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: input.title,
    dates: `${toGoogleUtcStamp(input.start)}/${toGoogleUtcStamp(input.end)}`,
  });
  if (input.details !== undefined) params.set('details', input.details);
  if (input.location !== undefined) params.set('location', input.location);
  return `${GOOGLE_CALENDAR_TEMPLATE_URL}?${params.toString()}`;
}
