/**
 * One-click "create event" links for the web calendars. Opening one shows that calendar's own
 * pre-filled event form, so the call lands in the reader's calendar regardless of how their
 * calendar treats an emailed `.ics` invite — Google Calendar, for one, may not add it on its own
 * ("Add invitations to my calendar" → "Only if the sender is known").
 *
 * The event each creates is the reader's own, unlinked from Balo's invite UID: a later reschedule
 * or cancellation `.ics` does not update it. Callers carry only what the `.ics` carries — never a
 * counterparty address (ADR-1044 §4).
 */
export interface CalendarLinkInput {
  readonly title: string;
  readonly start: Date;
  readonly end: Date;
  readonly details?: string;
  readonly location?: string;
}

const GOOGLE_CALENDAR_TEMPLATE_URL = 'https://calendar.google.com/calendar/render';

/** Outlook on the web: `personal` is Outlook.com, `work` is Microsoft 365 (work or school). */
export type OutlookCalendarKind = 'personal' | 'work';

const OUTLOOK_COMPOSE_URL: Record<OutlookCalendarKind, string> = {
  personal: 'https://outlook.live.com/calendar/0/action/compose',
  work: 'https://outlook.office.com/calendar/0/action/compose',
};

/**
 * `2026-11-17T22:00:00.000Z` → `20261117T220000Z` — the RFC 5545 UTC basic format, which is also
 * what Google's `dates` parameter takes. The ONE definition (the web `.ics` download uses it too).
 */
export function toIcsUtcStamp(date: Date): string {
  const [stamp] = date.toISOString().replace(/[-:]/g, '').split('.');
  return `${stamp ?? ''}Z`;
}

/** `2026-11-17T22:00:00.000Z` → `2026-11-17T22:00:00Z` (Outlook takes ISO 8601 with an offset). */
function toOutlookUtcStamp(date: Date): string {
  const [stamp] = date.toISOString().split('.');
  return `${stamp ?? ''}Z`;
}

export function buildGoogleCalendarLink(input: Readonly<CalendarLinkInput>): string {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: input.title,
    dates: `${toIcsUtcStamp(input.start)}/${toIcsUtcStamp(input.end)}`,
  });
  if (input.details !== undefined) params.set('details', input.details);
  if (input.location !== undefined) params.set('location', input.location);
  return `${GOOGLE_CALENDAR_TEMPLATE_URL}?${params.toString()}`;
}

export function buildOutlookCalendarLink(
  input: Readonly<CalendarLinkInput>,
  kind: OutlookCalendarKind
): string {
  const params = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: input.title,
    startdt: toOutlookUtcStamp(input.start),
    enddt: toOutlookUtcStamp(input.end),
  });
  if (input.details !== undefined) params.set('body', input.details);
  if (input.location !== undefined) params.set('location', input.location);
  return `${OUTLOOK_COMPOSE_URL[kind]}?${params.toString()}`;
}
