import { ADD_TO_CALENDAR_PATH_PREFIX } from '@balo/shared/calendar';
import { signAddToCalendarToken, type AddToCalendarEvent } from '@balo/shared/calendar-link-token';
import { createLogger } from '@balo/shared/logging';

const log = createLogger('calendar-invite-add-link');

/**
 * The invite email's "Add to calendar" link: Balo's own `/add-to-calendar/{token}` page, which
 * offers the web calendars one click each and a `.ics` download. The token carries the same title,
 * window, description and location as the attached ICS, signed so the page can trust it without
 * a database read (`@balo/shared/calendar-link-token`).
 *
 * `undefined` when `INTERNAL_API_SECRET` is unset or the event is outside the token limits — the
 * email then simply has no such button; the attached ICS is still the invite.
 */
export function buildAddToCalendarUrl(event: Readonly<AddToCalendarEvent>): string | undefined {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) {
    log.warn(
      'INTERNAL_API_SECRET is not set — invite email sent without an "Add to calendar" link'
    );
    return undefined;
  }
  const base = process.env.APP_URL ?? 'https://balo.expert';
  try {
    return `${base}${ADD_TO_CALENDAR_PATH_PREFIX}${signAddToCalendarToken(event, secret)}`;
  } catch (error) {
    // An event outside the token limits (e.g. an over-long title) would make a page the link
    // can't open — so no button at all, and the attached ICS still carries the invite.
    log.warn(
      {
        titleLength: event.title.length,
        error: error instanceof Error ? error.message : String(error),
      },
      'Calendar event is outside the add-to-calendar token limits — invite email sent without the link'
    );
    return undefined;
  }
}
